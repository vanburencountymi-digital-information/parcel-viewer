// What the parcel card shows (A5 / DIC-407): sections of labelled fields, each value
// produced by a named formatter (formatters.js). The engine's popup renderer
// (ISV_POPUP.renderSections) turns this config plus a parcel into rows.
//
// A theme can supply its own popup on the manifest's parcels source. It's used only when it
// has rich sections (with `fields`); today's VBC manifest names sections only, so the card
// uses PARCEL_POPUP.
export const PARCEL_POPUP = {
  sections: [
    { title: 'Parcel', fields: [
      { label: 'Address', field: 'prop_street', format: 'site_address' },
      { label: 'Area', field: 'gis_acres', format: 'area_units',
        tip: 'Parcel area calculated from the mapped boundary' },
      { label: 'Center', field: '_center', format: 'center_point', skipEmpty: true,
        tip: 'A point inside the parcel boundary. Format follows the coordinate readout at bottom-right (click it to change).' },
      { label: 'Class', field: 'prop_class', format: 'class_display',
        tip: 'Michigan STC property classification code and description' },
      { label: 'School', field: 'school_dist', format: 'school_display',
        tip: 'School district code' },
      { label: 'Geometry', field: 'source', format: 'source_provenance', skipEmpty: true,
        tip: 'How this geometry row was created (COGO commit, split, merge, boundary adjustment, or original shapefile migration)' } ] },
    { title: 'Owner', fields: [
      { label: 'Name', field: 'owner_name' },
      { label: 'Mailing', field: 'owner_street', format: 'owner_mail',
        tip: 'Owner\'s mailing address as recorded in the tax roll',
        style: 'white-space:normal;word-break:break-word' } ] },
    { title: 'Assessed Values', fields: [
      { label: 'AV', field: 'assessed_value', format: 'money',
        tip: 'Assessed Value - set by the assessor at 50% of estimated True Cash Value (TCV)' },
      { label: 'AV Prior', field: 'prev_assessed_value', format: 'money',
        tip: 'Prior year\'s Assessed Value' },
      { label: 'TV', field: 'taxable_value', format: 'money',
        tip: 'Taxable Value - the value taxes are actually levied on. Capped each year at the lesser of SEV or prior year TV plus the inflation rate (Michigan Proposal A).' },
      { label: 'TV Prior', field: 'prev_taxable_value', format: 'money',
        tip: 'Prior year\'s Taxable Value' },
      { label: 'TMV', field: 'assessed_value', format: 'true_market_value',
        tip: 'True Market Value (estimated) - calculated as 2x Assessed Value' },
      { label: 'TMV Prior', field: 'prev_assessed_value', format: 'true_market_value',
        tip: 'Prior estimated True Market Value - calculated as 2x prior Assessed Value' },
      { label: 'AV History', field: 'assessed_value_yr0', format: 'av_history',
        tip: '5-year assessed value history (oldest to newest)' },
      { label: 'PRE', field: 'homestead', format: 'percent',
        tip: 'Principal Residence Exemption - reduces taxable value for the owner\'s primary home. 100% = full exemption; 0% = no exemption (rental, vacant, or non-homestead)' } ] },
    { title: 'Tax Description', fields: [
      { label: 'Description', field: 'ps_legal_description', format: 'tax_description' } ] },
  ],
};

/** The popup config for the parcels source: the manifest's when it's rich, else PARCEL_POPUP. */
export function parcelPopupSource(manifestSource) {
  const idField = (manifestSource && manifestSource.idField) || 'pin';
  const pop = manifestSource && manifestSource.popup;
  const rich = pop && Array.isArray(pop.sections) && pop.sections.some((s) => s && Array.isArray(s.fields));
  return rich
    ? { id: manifestSource.id || 'parcels', idField, popup: pop }
    : { id: 'parcels', idField, popup: PARCEL_POPUP };
}
