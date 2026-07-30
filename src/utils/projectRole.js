/**
 * Allowed values for HubSpot contact property `project_role__sales_rep`
 * (fetched from HubSpot CRM property options).
 */
const HUBSPOT_PROJECT_ROLES = [
  'Homeowner',
  'Unknown',
  'Designer',
  'Contractor',
  'Engineer Drafter',
  'Realtor/Property Manager',
  'Other Professionals',
  'Landscape Architect',
  'Design Build',
  'Landscape Designer',
  'Geotech',
  'Land Surveyor',
  'Interior Designer',
  'MEP Engineer',
  'Lead Provider',
  'Developer',
  'Claims Adjuster',
  'HOA',
  'Home Builder',
  'Estimating & Takeoff',
  'Water Proofing',
  'Licensed Engineer (Civil/Structural)',
  'Energy Compliance',
  'Licensed Civil Engineer',
  'Licensed Architect',
  'Design Drafter',
];

/**
 * Common form / meeting-tool labels that are NOT exact HubSpot options,
 * mapped to the closest allowed value.
 */
const PROJECT_ROLE_ALIASES = {
  architect: 'Licensed Architect',
  'architectural drafter': 'Design Drafter',
  drafter: 'Design Drafter',
  'civil engineer': 'Licensed Civil Engineer',
  engineer: 'Licensed Engineer (Civil/Structural)',
  'structural engineer': 'Licensed Engineer (Civil/Structural)',
  realtor: 'Realtor/Property Manager',
  'property manager': 'Realtor/Property Manager',
  'aec professional (architect/engineer/contractor etc.)': 'Other Professionals',
  'aec professional': 'Other Professionals',
};

/**
 * Normalize an incoming role string to a HubSpot-allowed `project_role__sales_rep` value.
 * Exact match (case-insensitive) against HubSpot options first, then aliases, else "Unknown".
 */
function normalizeProjectRole(input) {
  const raw = String(input || '').trim();
  if (!raw) return 'Unknown';

  const lower = raw.toLowerCase();

  const exact = HUBSPOT_PROJECT_ROLES.find((opt) => opt.toLowerCase() === lower);
  if (exact) return exact;

  if (PROJECT_ROLE_ALIASES[lower]) return PROJECT_ROLE_ALIASES[lower];

  return 'Unknown';
}

module.exports = {
  HUBSPOT_PROJECT_ROLES,
  PROJECT_ROLE_ALIASES,
  normalizeProjectRole,
};
