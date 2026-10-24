-- e2e fixture database, part 1: the schema (DIC-2553).
--
-- The parcel tables and Martin tile functions exactly as the shared database has them
-- (another pipeline owns them; ADR 0006/0007), so the API's SQL and Martin's sources run
-- unchanged. Dumped 2026-10-23 with
--   pg_dump --schema-only --no-owner --no-privileges -t geo.<table> -t assessing.vbc_parcels
-- plus pg_get_functiondef() for every geo function. Re-dump when the pipeline changes a
-- table the API or a tile function reads. The data is 20-data.sql (build_fixture.py).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS geo;
CREATE SCHEMA IF NOT EXISTS assessing;

-- -- Functions: the parcel trigger and the Martin tile sources (geo.*_tiles) -----------

--  address_points_tiles
CREATE OR REPLACE FUNCTION geo.address_points_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

DECLARE mvt bytea;

BEGIN

    SELECT INTO mvt ST_AsMVT(tile, 'address_points', 4096, 'geom')

    FROM (

        SELECT

            id,

            fulladdr,

            addrnum,

            addr_sn,

            addr_st,

            municipali,

            pointtype,

            ST_AsMVTGeom(

                ST_Transform(geom, 3857),

                ST_TileEnvelope(z, x, y),

                4096, 64, true

            ) AS geom

        FROM geo.address_points

        WHERE geom && ST_Transform(ST_TileEnvelope(z, x, y), 2253)

    ) AS tile

    WHERE tile.geom IS NOT NULL;

    RETURN mvt;

END;

$function$
;

--  drains_tiles
CREATE OR REPLACE FUNCTION geo.drains_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

BEGIN

    RETURN geo.reference_drains_tiles(z, x, y);

END;

$function$
;

--  parcel_geometry_before_write
CREATE OR REPLACE FUNCTION geo.parcel_geometry_before_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$

BEGIN

    NEW.updated_at := NOW();



    -- Recompute acres/area whenever geometry is set or changed.

    -- EPSG:2253 units are US survey feet; 43,560 sq ft per acre.

    IF TG_OP = 'INSERT' OR NEW.geom IS DISTINCT FROM OLD.geom THEN

        NEW.area  := ST_Area(NEW.geom);

        NEW.acres := ST_Area(NEW.geom) / 43560.0;

    END IF;



    RETURN NEW;

END;

$function$
;

--  parcel_points_tiles
CREATE OR REPLACE FUNCTION geo.parcel_points_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

DECLARE mvt bytea;

BEGIN

    SELECT INTO mvt ST_AsMVT(tile, 'parcel_points', 4096, 'geom')

    FROM (

        SELECT

            id,

            parcel_no,

            ownername,

            acres,

            ST_AsMVTGeom(

                ST_Transform(geom, 3857),

                ST_TileEnvelope(z, x, y),

                4096, 64, true

            ) AS geom

        FROM geo.parcel_points

        WHERE geom && ST_Transform(ST_TileEnvelope(z, x, y), 2253)

    ) AS tile

    WHERE tile.geom IS NOT NULL;

    RETURN mvt;

END;

$function$
;

--  parcel_tiles
CREATE OR REPLACE FUNCTION geo.parcel_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

DECLARE

    mvt bytea;

BEGIN

    -- Property names match what the Parcel Studio frontend reads

    -- (lifted ZIP-POC modules key on pin / gis_acres / PCOMBINED).

    SELECT INTO mvt ST_AsMVT(tile, 'parcels', 4096, 'geom')

    FROM (

        SELECT

            pg.id,

            pg.parcel_no               AS pin,

            pg.parcel_no,

            pg.municipality,

            pg.acres                   AS gis_acres,

            a.owner_name,

            a.prop_street              AS "PCOMBINED",

            a.prop_class,

            ST_AsMVTGeom(

                ST_Transform(pg.geom, 3857),

                ST_TileEnvelope(z, x, y),

                4096, 64, true

            ) AS geom

        FROM geo.parcel_geometry pg

        LEFT JOIN assessing.vbc_parcels a ON a.pnum = pg.parcel_no

        WHERE pg.archived_at IS NULL

          AND pg.geom && ST_Transform(ST_TileEnvelope(z, x, y), 2253)

    ) AS tile

    WHERE tile.geom IS NOT NULL;



    RETURN mvt;

END;

$function$
;

--  plss_corners_tiles
CREATE OR REPLACE FUNCTION geo.plss_corners_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

DECLARE mvt bytea;

BEGIN

    SELECT INTO mvt ST_AsMVT(tile, 'plss_corners', 4096, 'geom')

    FROM (

        SELECT

            id,

            town,

            "range",

            corner_typ,

            tr,

            ST_AsMVTGeom(

                ST_Transform(geom, 3857),

                ST_TileEnvelope(z, x, y),

                4096, 64, true

            ) AS geom

        FROM geo.plss_corners

        WHERE geom && ST_Transform(ST_TileEnvelope(z, x, y), 2253)

    ) AS tile

    WHERE tile.geom IS NOT NULL;

    RETURN mvt;

END;

$function$
;

--  plss_section_lines_tiles
CREATE OR REPLACE FUNCTION geo.plss_section_lines_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

BEGIN

    RETURN geo.reference_section_lines_tiles(z, x, y);

END;

$function$
;

--  plss_sections_tiles
CREATE OR REPLACE FUNCTION geo.plss_sections_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

DECLARE mvt bytea;

BEGIN

    SELECT INTO mvt ST_AsMVT(tile, 'plss_sections', 4096, 'geom')

    FROM (

        SELECT

            id,

            twnrngsec,

            section_,

            muni,

            sq_ft,

            ST_AsMVTGeom(

                ST_Transform(geom, 3857),

                ST_TileEnvelope(z, x, y),

                4096, 64, true

            ) AS geom

        FROM geo.plss_sections

        WHERE geom && ST_Transform(ST_TileEnvelope(z, x, y), 2253)

    ) AS tile

    WHERE tile.geom IS NOT NULL;

    RETURN mvt;

END;

$function$
;

--  reference_drains_tiles
CREATE OR REPLACE FUNCTION geo.reference_drains_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

DECLARE mvt bytea;

BEGIN

    SELECT INTO mvt ST_AsMVT(tile, 'reference_drains', 4096, 'geom')

    FROM (

        SELECT

            id,

            drain_name AS name,

            drain_id AS source_id,

            drain_type,

            'drain' AS feature_type,

            ST_AsMVTGeom(

                ST_Transform(geom, 3857),

                ST_TileEnvelope(z, x, y),

                4096, 64, true

            ) AS geom

        FROM geo.drains

        WHERE geom && ST_Transform(ST_TileEnvelope(z, x, y), 2253)

    ) AS tile

    WHERE tile.geom IS NOT NULL;

    RETURN mvt;

END;

$function$
;

--  reference_roads_tiles
CREATE OR REPLACE FUNCTION geo.reference_roads_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

DECLARE mvt bytea;

BEGIN

    SELECT INTO mvt ST_AsMVT(tile, 'reference_roads', 4096, 'geom')

    FROM (

        SELECT

            id,

            COALESCE(NULLIF(st_name, ''), fullstn) AS name,

            road_id AS source_id,

            "type" AS road_type,

            rdclass,

            muni_l AS municipality,

            fullstn,

            st_name,

            'road' AS feature_type,

            ST_AsMVTGeom(

                ST_Transform(geom, 3857),

                ST_TileEnvelope(z, x, y),

                4096, 64, true

            ) AS geom

        FROM geo.road_centerlines

        WHERE geom && ST_Transform(ST_TileEnvelope(z, x, y), 2253)

    ) AS tile

    WHERE tile.geom IS NOT NULL;

    RETURN mvt;

END;

$function$
;

--  reference_section_lines_tiles
CREATE OR REPLACE FUNCTION geo.reference_section_lines_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

DECLARE mvt bytea;

BEGIN

    SELECT INTO mvt ST_AsMVT(tile, 'reference_section_lines', 4096, 'geom')

    FROM (

        SELECT

            id,

            twnrngsec AS name,

            twnrngsec AS source_id,

            'section_line' AS feature_type,

            ST_AsMVTGeom(

                ST_Transform(geom, 3857),

                ST_TileEnvelope(z, x, y),

                4096, 64, true

            ) AS geom

        FROM geo.plss_section_lines

        WHERE geom && ST_Transform(ST_TileEnvelope(z, x, y), 2253)

    ) AS tile

    WHERE tile.geom IS NOT NULL;

    RETURN mvt;

END;

$function$
;

--  road_centerlines_tiles
CREATE OR REPLACE FUNCTION geo.road_centerlines_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

BEGIN

    RETURN geo.reference_roads_tiles(z, x, y);

END;

$function$
;

--  section_centers_tiles
CREATE OR REPLACE FUNCTION geo.section_centers_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

DECLARE mvt bytea;

BEGIN

    SELECT INTO mvt ST_AsMVT(tile, 'section_centers', 4096, 'geom')

    FROM (

        SELECT

            id,

            twnrngsec,

            section_,

            muni,

            ST_AsMVTGeom(

                ST_Transform(geom, 3857),

                ST_TileEnvelope(z, x, y),

                4096, 64, true

            ) AS geom

        FROM geo.section_centers

        WHERE geom && ST_Transform(ST_TileEnvelope(z, x, y), 2253)

    ) AS tile

    WHERE tile.geom IS NOT NULL;

    RETURN mvt;

END;

$function$
;

--  subdivisions_tiles
CREATE OR REPLACE FUNCTION geo.subdivisions_tiles(z integer, x integer, y integer)
 RETURNS bytea
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$

DECLARE mvt bytea;

BEGIN

    SELECT INTO mvt ST_AsMVT(tile, 'subdivisions', 4096, 'geom')

    FROM (

        SELECT

            id,

            sub_name,

            unit,

            twp_range,

            ST_AsMVTGeom(

                ST_Transform(geom, 3857),

                ST_TileEnvelope(z, x, y),

                4096, 64, true

            ) AS geom

        FROM geo.subdivisions

        WHERE geom && ST_Transform(ST_TileEnvelope(z, x, y), 2253)

    ) AS tile

    WHERE tile.geom IS NOT NULL;

    RETURN mvt;

END;

$function$
;

-- -- Tables, sequences, keys and indexes ------------------------------------------

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE assessing.vbc_parcels (
    id bigint NOT NULL,
    pnum text NOT NULL,
    mapnum text,
    school_dist text,
    prop_class text,
    homestead numeric,
    qual_ag text,
    frontage double precision,
    avg_depth double precision,
    assessed_value integer,
    taxable_value integer,
    prev_assessed_value integer,
    prev_taxable_value integer,
    assessed_value_yr0 integer,
    assessed_value_yr1 integer,
    assessed_value_yr2 integer,
    assessed_value_yr3 integer,
    assessed_value_yr4 integer,
    owner_name text,
    prop_street text,
    prop_city text,
    prop_state text,
    prop_zip text,
    owner_street text,
    owner_city text,
    owner_state text,
    owner_zip text,
    legal_description text,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE assessing.vbc_parcels_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE assessing.vbc_parcels_id_seq OWNED BY assessing.vbc_parcels.id;

CREATE TABLE geo.address_points (
    id integer NOT NULL,
    comments text,
    status text,
    alias3_sn text,
    alias3_pd text,
    lasteditor text,
    alias5_sn text,
    "using" text,
    alias2_sd text,
    alias2_st text,
    alias2_sn text,
    capturemet text,
    alias2_pd text,
    alias1_st text,
    townname text,
    placename text,
    site text,
    globalid text,
    addr_pd text,
    addr_pt text,
    addr_sn text,
    addr_st text,
    addr_sd text,
    alias1_sd text,
    alias1_pd text,
    pointtype text,
    usngcoord text,
    alias4_sn text,
    siteaddid text,
    addptkey text,
    preaddrnum text,
    addrnumsuf text,
    addrnum text,
    addrrange text,
    unittype text,
    unitid text,
    alias3_st text,
    altunittyp text,
    fullname text,
    fulladdr text,
    alias3_sd text,
    section_no text,
    municipali text,
    esn text,
    psap text,
    msag text,
    altunitid text,
    alias1_sn text,
    fire bigint,
    law bigint,
    fips bigint,
    mcode bigint,
    at_id bigint,
    addrclass bigint,
    postoffice bigint,
    ems bigint,
    lastupdate date,
    issue_date date,
    url text,
    st_name text,
    geom public.geometry(Point,2253) NOT NULL,
    source_file text,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE geo.address_points_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.address_points_id_seq OWNED BY geo.address_points.id;

CREATE TABLE geo.drains (
    id integer NOT NULL,
    drain_id text,
    drain_name text,
    row_width text,
    drain_type text,
    tile_size text,
    doc_source text,
    date_estab text,
    outlet_nam text,
    mapped_by text,
    modified_b text,
    modified_d date,
    archive text,
    historic_d text,
    doucment_l text,
    length_mil double precision,
    comments text,
    geom public.geometry(MultiLineString,2253) NOT NULL,
    source_file text,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE geo.drains_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.drains_id_seq OWNED BY geo.drains.id;

CREATE TABLE geo.parcel_geometry (
    id bigint NOT NULL,
    parcel_no text NOT NULL,
    county text NOT NULL,
    municipality text NOT NULL,
    geom public.geometry(MultiPolygon,2253) NOT NULL,
    acres double precision,
    area double precision,
    source_file text,
    loaded_at timestamp with time zone DEFAULT now(),
    legal_description text,
    tax_description text,
    cogo_legs jsonb,
    source text DEFAULT 'migration'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone
);

COMMENT ON COLUMN geo.parcel_geometry.cogo_legs IS 'COGO course array at time of commit, e.g. [{"seq":1,"type":"straight","bearing":"N89°21''30"E","distance":247.90,"unit":"ft","bowditch_adjusted":true}, ...]';

COMMENT ON COLUMN geo.parcel_geometry.source IS 'Row provenance: migration | cogo_commit | split | merge | boundary_adjust | bs_and_a_import';

COMMENT ON COLUMN geo.parcel_geometry.archived_at IS 'Soft-archive timestamp. Non-null rows are superseded (by split/merge/edit) and excluded from active views and tiles.';

CREATE SEQUENCE geo.parcel_geometry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.parcel_geometry_id_seq OWNED BY geo.parcel_geometry.id;

CREATE TABLE geo.parcel_ledger_events (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    parcel_id integer NOT NULL,
    event_type text NOT NULL,
    event_timestamp timestamp with time zone DEFAULT now() NOT NULL,
    operator_id text NOT NULL,
    source_document text,
    closure_error numeric,
    precision_ratio text,
    bowditch_applied boolean,
    cogo_legs jsonb,
    geometry_before public.geometry(MultiPolygon,2253),
    geometry_after public.geometry(MultiPolygon,2253),
    related_parcel_ids integer[],
    notes text,
    CONSTRAINT parcel_ledger_events_event_type_check CHECK ((event_type = ANY (ARRAY['cogo_create'::text, 'cogo_edit'::text, 'split'::text, 'merge'::text, 'boundary_adjust'::text])))
);

CREATE TABLE geo.parcel_points (
    id integer NOT NULL,
    parcel_no text,
    currmbora double precision,
    currmbort double precision,
    ownername text,
    tcvyr0 double precision,
    tcvyr1 double precision,
    tcvyr2 double precision,
    tcvyr3 double precision,
    tcvyr4 double precision,
    acres double precision,
    area double precision,
    orig_fid bigint,
    geom public.geometry(Point,2253) NOT NULL,
    source_file text,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE geo.parcel_points_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.parcel_points_id_seq OWNED BY geo.parcel_points.id;

CREATE TABLE geo.plss_corners (
    id integer NOT NULL,
    accuracy text,
    code text,
    tr text,
    unit text,
    gislink text,
    objectid bigint,
    county_nam text,
    town text,
    range text,
    corner_cod text,
    corner_typ text,
    pc_reserve text,
    grant_year text,
    peer_appro text,
    recorded_d text,
    researched text,
    ps_id text,
    liber text,
    first_page text,
    document_n text,
    decimal_la text,
    decimal_lo text,
    deviation_ text,
    deviation1 text,
    grid_facto text,
    latitude_n text,
    longitude_ text,
    observe_da text,
    zone text,
    spc_nad_22 text,
    spc_nad_23 text,
    spc_nad_83 text,
    spc_nad_84 text,
    corner_sta text,
    gislink_1 text,
    geom public.geometry(Point,2253) NOT NULL,
    source_file text,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE geo.plss_corners_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.plss_corners_id_seq OWNED BY geo.plss_corners.id;

CREATE TABLE geo.plss_section_lines (
    id integer NOT NULL,
    section_id bigint,
    twnrngsec text,
    sec bigint,
    section_ text,
    municipality text,
    county text,
    geom public.geometry(MultiLineString,2253) NOT NULL,
    source_file text,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE geo.plss_section_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.plss_section_lines_id_seq OWNED BY geo.plss_section_lines.id;

CREATE TABLE geo.plss_sections (
    id integer NOT NULL,
    objectid bigint,
    area double precision,
    perimeter double precision,
    sectionlp_ double precision,
    sectionlp1 double precision,
    town text,
    twn text,
    range text,
    rng text,
    section_ text,
    sec bigint,
    twnrng text,
    twnrngsec text,
    claim bigint,
    govlot bigint,
    other text,
    county text,
    cnty2 text,
    x_coord double precision,
    y_coord double precision,
    muni text,
    sq_ft double precision,
    td text,
    rd text,
    tnum text,
    rnum text,
    geom public.geometry(MultiPolygon,2253) NOT NULL,
    source_file text,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE geo.plss_sections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.plss_sections_id_seq OWNED BY geo.plss_sections.id;

CREATE TABLE geo.reference_layers (
    id integer NOT NULL,
    feature_type text NOT NULL,
    name text,
    source text,
    source_id text,
    geom public.geometry(MultiLineString,2253) NOT NULL,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE geo.reference_layers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.reference_layers_id_seq OWNED BY geo.reference_layers.id;

CREATE TABLE geo.road_centerlines (
    id integer NOT NULL,
    objectid_1 bigint,
    source text,
    dateupd date,
    effdate date,
    country text,
    state_l text,
    state_r text,
    county_l text,
    county_r text,
    muni_l text,
    muni_r text,
    mcddiv_l text,
    mcddiv_r text,
    uncorp_l text,
    uncorp_r text,
    nghbrhd_l text,
    nghbrhd_r text,
    adrgpre_l text,
    adrgpre_r text,
    addr_l_fro bigint,
    addr_l_to bigint,
    addr_r_fro bigint,
    addr_r_to bigint,
    pstcomm_l text,
    pstcomm_r text,
    zipcode_l text,
    zipcode_r text,
    esn_l text,
    esn_r text,
    psap_l text,
    psap_r text,
    msag_comm_ text,
    msag_comm1 text,
    st_pre_dir text,
    st_pos_typ text,
    st_pos_dir text,
    stpostmod text,
    fullstn text,
    speedlimit bigint,
    oneway text,
    rdclass text,
    collmthd bigint,
    gsf bigint,
    gst bigint,
    rdsurface bigint,
    notes text,
    exceptioon bigint,
    type text,
    road_id text,
    st_name text,
    geom public.geometry(MultiLineString,2253) NOT NULL,
    source_file text,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE geo.road_centerlines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.road_centerlines_id_seq OWNED BY geo.road_centerlines.id;

CREATE TABLE geo.section_centers (
    id integer NOT NULL,
    objectid_1 double precision,
    objectid bigint,
    area double precision,
    perimeter double precision,
    sectionlp_ double precision,
    sectionlp1 double precision,
    town text,
    twn text,
    range text,
    rng text,
    section_ text,
    sec bigint,
    twnrng text,
    twnrngsec text,
    claim bigint,
    govlot bigint,
    other text,
    county text,
    cnty2 text,
    x_coord double precision,
    y_coord double precision,
    muni text,
    sq_ft double precision,
    geom public.geometry(Point,2253) NOT NULL,
    source_file text,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE geo.section_centers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.section_centers_id_seq OWNED BY geo.section_centers.id;

CREATE TABLE geo.subdivisions (
    id integer NOT NULL,
    shapefile_id bigint,
    sub_name text,
    unit text,
    twp_range text,
    link text,
    geom public.geometry(MultiPolygon,2253) NOT NULL,
    source_file text,
    loaded_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE geo.subdivisions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE geo.subdivisions_id_seq OWNED BY geo.subdivisions.id;

ALTER TABLE ONLY assessing.vbc_parcels ALTER COLUMN id SET DEFAULT nextval('assessing.vbc_parcels_id_seq'::regclass);

ALTER TABLE ONLY geo.address_points ALTER COLUMN id SET DEFAULT nextval('geo.address_points_id_seq'::regclass);

ALTER TABLE ONLY geo.drains ALTER COLUMN id SET DEFAULT nextval('geo.drains_id_seq'::regclass);

ALTER TABLE ONLY geo.parcel_geometry ALTER COLUMN id SET DEFAULT nextval('geo.parcel_geometry_id_seq'::regclass);

ALTER TABLE ONLY geo.parcel_points ALTER COLUMN id SET DEFAULT nextval('geo.parcel_points_id_seq'::regclass);

ALTER TABLE ONLY geo.plss_corners ALTER COLUMN id SET DEFAULT nextval('geo.plss_corners_id_seq'::regclass);

ALTER TABLE ONLY geo.plss_section_lines ALTER COLUMN id SET DEFAULT nextval('geo.plss_section_lines_id_seq'::regclass);

ALTER TABLE ONLY geo.plss_sections ALTER COLUMN id SET DEFAULT nextval('geo.plss_sections_id_seq'::regclass);

ALTER TABLE ONLY geo.reference_layers ALTER COLUMN id SET DEFAULT nextval('geo.reference_layers_id_seq'::regclass);

ALTER TABLE ONLY geo.road_centerlines ALTER COLUMN id SET DEFAULT nextval('geo.road_centerlines_id_seq'::regclass);

ALTER TABLE ONLY geo.section_centers ALTER COLUMN id SET DEFAULT nextval('geo.section_centers_id_seq'::regclass);

ALTER TABLE ONLY geo.subdivisions ALTER COLUMN id SET DEFAULT nextval('geo.subdivisions_id_seq'::regclass);

ALTER TABLE ONLY assessing.vbc_parcels
    ADD CONSTRAINT vbc_parcels_pkey PRIMARY KEY (id);

ALTER TABLE ONLY geo.address_points
    ADD CONSTRAINT address_points_pkey PRIMARY KEY (id);

ALTER TABLE ONLY geo.drains
    ADD CONSTRAINT drains_pkey PRIMARY KEY (id);

ALTER TABLE geo.parcel_geometry
    ADD CONSTRAINT parcel_geometry_geom_valid CHECK (public.st_isvalid(geom)) NOT VALID;

ALTER TABLE ONLY geo.parcel_geometry
    ADD CONSTRAINT parcel_geometry_pkey PRIMARY KEY (id);

ALTER TABLE ONLY geo.parcel_ledger_events
    ADD CONSTRAINT parcel_ledger_events_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY geo.parcel_points
    ADD CONSTRAINT parcel_points_pkey PRIMARY KEY (id);

ALTER TABLE ONLY geo.plss_corners
    ADD CONSTRAINT plss_corners_pkey PRIMARY KEY (id);

ALTER TABLE ONLY geo.plss_section_lines
    ADD CONSTRAINT plss_section_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY geo.plss_sections
    ADD CONSTRAINT plss_sections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY geo.reference_layers
    ADD CONSTRAINT reference_layers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY geo.road_centerlines
    ADD CONSTRAINT road_centerlines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY geo.section_centers
    ADD CONSTRAINT section_centers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY geo.subdivisions
    ADD CONSTRAINT subdivisions_pkey PRIMARY KEY (id);

CREATE INDEX vbc_parcels_pnum_idx ON assessing.vbc_parcels USING btree (pnum);

CREATE INDEX address_points_fulladdr_idx ON geo.address_points USING btree (fulladdr);

CREATE INDEX address_points_geom_idx ON geo.address_points USING gist (geom);

CREATE INDEX drains_drain_id_idx ON geo.drains USING btree (drain_id);

CREATE INDEX drains_drain_name_idx ON geo.drains USING btree (drain_name);

CREATE INDEX drains_geom_idx ON geo.drains USING gist (geom);

CREATE INDEX parcel_geometry_active_geom_idx ON geo.parcel_geometry USING gist (geom) WHERE (archived_at IS NULL);

CREATE INDEX parcel_geometry_county_municipality_idx ON geo.parcel_geometry USING btree (county, municipality);

CREATE INDEX parcel_geometry_geom_idx ON geo.parcel_geometry USING gist (geom);

CREATE INDEX parcel_ledger_events_parcel_id_idx ON geo.parcel_ledger_events USING btree (parcel_id);

CREATE INDEX parcel_ledger_events_timestamp_idx ON geo.parcel_ledger_events USING btree (event_timestamp);

CREATE INDEX parcel_ledger_events_type_idx ON geo.parcel_ledger_events USING btree (event_type);

CREATE INDEX parcel_points_geom_idx ON geo.parcel_points USING gist (geom);

CREATE INDEX parcel_points_parcel_no_idx ON geo.parcel_points USING btree (parcel_no);

CREATE INDEX plss_corners_geom_idx ON geo.plss_corners USING gist (geom);

CREATE INDEX plss_section_lines_geom_idx ON geo.plss_section_lines USING gist (geom);

CREATE INDEX plss_section_lines_twnrngsec_idx ON geo.plss_section_lines USING btree (twnrngsec);

CREATE INDEX plss_sections_geom_idx ON geo.plss_sections USING gist (geom);

CREATE INDEX plss_sections_twnrngsec_idx ON geo.plss_sections USING btree (twnrngsec);

CREATE INDEX reference_layers_geom_idx ON geo.reference_layers USING gist (geom);

CREATE INDEX reference_layers_name_idx ON geo.reference_layers USING btree (name);

CREATE INDEX reference_layers_type_idx ON geo.reference_layers USING btree (feature_type);

CREATE INDEX road_centerlines_geom_idx ON geo.road_centerlines USING gist (geom);

CREATE INDEX road_centerlines_muni_l_idx ON geo.road_centerlines USING btree (muni_l);

CREATE INDEX road_centerlines_road_id_idx ON geo.road_centerlines USING btree (road_id);

CREATE INDEX road_centerlines_st_name_idx ON geo.road_centerlines USING btree (st_name);

CREATE INDEX road_centerlines_type_idx ON geo.road_centerlines USING btree (type);

CREATE INDEX section_centers_geom_idx ON geo.section_centers USING gist (geom);

CREATE INDEX subdivisions_geom_idx ON geo.subdivisions USING gist (geom);

CREATE TRIGGER parcel_geometry_before_write_trg BEFORE INSERT OR UPDATE ON geo.parcel_geometry FOR EACH ROW EXECUTE FUNCTION geo.parcel_geometry_before_write();

ALTER TABLE ONLY geo.parcel_ledger_events
    ADD CONSTRAINT parcel_ledger_events_parcel_id_fkey FOREIGN KEY (parcel_id) REFERENCES geo.parcel_geometry(id);
