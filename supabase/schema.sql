-- Expedientes · esquema Supabase (pegar en SQL Editor y ejecutar una vez)
create extension if not exists pgcrypto;

create table if not exists jueces (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  juzgado text not null,
  contacto text,
  clave_publica jsonb,              -- JWK Ed25519 (MVP); en producción, certificado de firma digital
  alg text default 'Ed25519'
);

create table if not exists turnos (
  id uuid primary key default gen_random_uuid(),
  juez_id uuid not null references jueces(id) on delete cascade,
  jurisdiccion text not null,
  desde timestamptz not null,
  hasta timestamptz not null,
  check (hasta > desde)
);
create index if not exists turnos_vigencia on turnos (jurisdiccion, desde, hasta);

create table if not exists expedientes (
  id uuid primary key default gen_random_uuid(),
  numero text unique not null,
  partido jsonb not null,
  kickoff timestamptz not null,
  jurisdiccion text not null,
  objetivo text not null,
  host_video text,
  estado text not null default 'borrador'
    check (estado in ('borrador','revision_humana','en_cola_juez','firmado','rechazado','anexado')),
  consenso jsonb,
  contenido jsonb not null,          -- expediente completo (evidencia)
  sha256 text,                       -- hash del expediente congelado
  tsa jsonb,                         -- sello RFC 3161
  anexo_de uuid references expedientes(id),
  reportado_por uuid references auth.users(id),
  creado_at timestamptz not null default now()
);

create table if not exists firmas (
  id uuid primary key default gen_random_uuid(),
  expediente_id uuid not null references expedientes(id),
  juez_id uuid not null references jueces(id),
  sha256 text not null,
  ts timestamptz not null default now(),
  alg text not null,
  firma text not null
);

create table if not exists ordenes (
  id uuid primary key default gen_random_uuid(),
  numero text unique not null,
  expediente_id uuid not null references expedientes(id),
  objetivo text not null,
  tipo text not null,
  juzgado text not null,
  firmada_at timestamptz not null default now(),
  hasta timestamptz,
  levantada_at timestamptz,
  origen text default 'firma'
);

create table if not exists reclamos (
  id uuid primary key default gen_random_uuid(),
  dominio text not null,
  contacto text,
  motivo text,
  orden_id uuid references ordenes(id),
  estado text not null default 'pendiente',
  creado_at timestamptz not null default now()
);

create table if not exists auditoria (
  i bigserial primary key,
  ts timestamptz not null default now(),
  accion text not null,
  expediente_id uuid,
  detalle text,
  actor uuid default auth.uid(),
  prev text not null,
  hash text not null
);

-- Cadena de auditoría: cada evento incluye el hash del anterior
create or replace function auditoria_encadenar() returns trigger language plpgsql security definer as $$
declare p text;
begin
  select hash into p from auditoria order by i desc limit 1 for update;
  new.prev := coalesce(p, repeat('0', 64));
  new.hash := encode(digest(new.prev || '|' || new.ts::text || '|' || new.accion || '|' || coalesce(new.expediente_id::text,'') || '|' || coalesce(new.detalle,''), 'sha256'), 'hex');
  return new;
end $$;
drop trigger if exists t_auditoria on auditoria;
create trigger t_auditoria before insert on auditoria for each row execute function auditoria_encadenar();

-- Juez competente: se resuelve por consulta, no se guarda en el expediente
create or replace function juez_competente(j text, t timestamptz default now())
returns uuid language sql stable as $$
  select juez_id from turnos where jurisdiccion = j and t between desde and hasta order by desde desc limit 1
$$;

-- RLS
alter table jueces enable row level security;
alter table turnos enable row level security;
alter table expedientes enable row level security;
alter table firmas enable row level security;
alter table ordenes enable row level security;
alter table reclamos enable row level security;
alter table auditoria enable row level security;

create policy juez_lee_su_ficha on jueces for select using (id = auth.uid());
create policy juez_ve_sus_turnos on turnos for select using (juez_id = auth.uid());

create policy juez_de_turno_lee on expedientes for select using (
  exists (select 1 from turnos t where t.juez_id = auth.uid()
          and now() between t.desde and t.hasta and t.jurisdiccion = expedientes.jurisdiccion)
);
create policy juez_de_turno on expedientes for update using (
  exists (select 1 from turnos t where t.juez_id = auth.uid()
          and now() between t.desde and t.hasta and t.jurisdiccion = expedientes.jurisdiccion)
);
create policy reportante_crea on expedientes for insert with check (reportado_por = auth.uid());
create policy reportante_lee on expedientes for select using (reportado_por = auth.uid());

create policy juez_firma on firmas for insert with check (
  juez_id = auth.uid() and exists (
    select 1 from expedientes e join turnos t on t.jurisdiccion = e.jurisdiccion
    where e.id = firmas.expediente_id and e.sha256 = firmas.sha256 and e.estado = 'en_cola_juez'
      and t.juez_id = auth.uid() and now() between t.desde and t.hasta)
);
create policy firmas_lectura on firmas for select using (true);

create policy juez_ordena on ordenes for insert with check (
  exists (select 1 from firmas f where f.expediente_id = ordenes.expediente_id and f.juez_id = auth.uid())
);
create policy juez_levanta on ordenes for update using (
  exists (select 1 from expedientes e join turnos t on t.jurisdiccion = e.jurisdiccion
          where e.id = ordenes.expediente_id and t.juez_id = auth.uid() and now() between t.desde and t.hasta)
);

create policy reclamo_publico on reclamos for insert with check (estado = 'pendiente');
create policy auditoria_insert on auditoria for insert with check (auth.uid() is not null);
create policy auditoria_lectura on auditoria for select using (auth.uid() is not null);

-- Registro público de transparencia (sin evidencia ni identidad de quien reportó)
create or replace view registro_publico with (security_invoker = false) as
select o.numero as orden, o.objetivo, o.tipo, o.juzgado, o.firmada_at as desde, o.hasta, o.origen,
  case when o.levantada_at is not null then 'levantada por reclamo'
       when o.hasta is not null and o.hasta < now() then 'vencida' else 'vigente' end as estado
from ordenes o;
create or replace view cabecera_auditoria with (security_invoker = false) as
select i as evento, hash from auditoria order by i desc limit 1;
grant select on registro_publico, cabecera_auditoria to anon, authenticated;

-- Cola en vivo (Supabase Realtime)
alter publication supabase_realtime add table expedientes;
-- En el cliente: canal postgres_changes sobre expedientes con filtro estado=eq.en_cola_juez,
-- ordenado por kickoff + 110 min - now().

-- Aviso: Database Webhook (Supabase → n8n) en INSERT/UPDATE de expedientes cuando estado = 'en_cola_juez';
-- n8n consulta juez_competente(jurisdiccion) y manda WhatsApp o mail con el link a /#/juez?exp=<id>.
