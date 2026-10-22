/**
 * Everything specific to the Neozaar marketplace, in one place: the values its Create Service form accepts, how CloudBuilder's categories map onto
 * its categories, and the defaults used when a template has no listing details of its own. To change what an import sends, change this file.
 *
 * The allowed values are the ones the form offers (read from its screens). They are stored by Neozaar as text, so they are sent as text.
 * Entries marked `confirm` are proposals that a person at Neozaar has not yet agreed to: the export lists them under `review`.
 */

export const ALLOWED = {
  industry: ['Defense', 'Public Sector', 'Utilities', 'Energy', 'Life Sciences', 'Media & Entertainment', 'E-commerce', 'Legal', 'PSU', 'Pharma', 'Telecom', 'Retail', 'NBFC', 'Manufacturing', 'IT_ITES', 'Healthcare', 'BFSI', 'ISV'],
  targetSegments: ['Government', 'Education', 'Public Sector', 'Large Enterprise', 'Mid Markets', 'ISV', 'SMB', 'Enterprise'],
  targetAudience: ['DevSecOps Lead', 'DPO', 'CFO', 'CEO', 'EndPoint Admin', 'Network Lead', 'IAM Lead', 'SOC Lead', 'IT Head', 'CTO', 'CIO', 'CISO', 'Procurement Teams', 'ISV', 'Remote Workforce Leaders', 'Compliance Officers'],
  ctaModel: ['Free Trial', 'Request Deployment', 'Request Scoping', 'Request Assessment'],
  platform: ['AWS', 'Azure', 'GCP', 'SaaS', 'On-Premise'],
  pricingModel: ['One Time', 'Monthly Subscription', 'Quarterly Subscription', 'Yearly Subscription', '3 Year Subscription'],
  actionFor: ['customer', 'isv', 'both'],
  category: ['Secure & Protect', 'Cloud Infrastructure', 'Modernise Workplace', 'Business Operations', 'Migrate to Cloud', 'Adapt AI & Data', 'Go to Market', 'Protect & Recover Data', 'Continuous Compliance', 'Optimise the Cloud', 'Operate & Manage Cloud', 'Modernize Applications & Data'],
} as const;

/** The sub-categories that are known (the form shows them once a category is chosen). Only the categories this export uses are listed. */
export const SUBCATEGORIES: Record<string, readonly string[]> = {
  'Cloud Infrastructure': ['Storage', 'Compute', 'Databases', 'Networking', 'Containers', 'Cloud Environments', 'Landing Zone'],
  'Protect & Recover Data': ['Device Management', 'Recovery', 'Data Protection', 'Disaster Recovery', 'SaaS Backup', 'Vaulting', 'Archiving'],
  'Adapt AI & Data': ['AI Agents', 'Data Platforms', 'AI-Ready Data Foundation', 'Managed Data & AI', 'Analytics & Business Intelligence'],
  'Business Operations': ['HRMS', 'Procurement'],
};

/** What every imported template is: a service, from Neozaar, for customers and ISVs, available everywhere. */
export const FIXED = {
  type: 'product',          // the catalog route's :type (a service is a product with action_type "service")
  action_type: 'service',
  brand_name: 'Neozaar',
  action_for: 'both',
  regions: ['Global'],
  pricing_model: 'Monthly Subscription',
} as const;

/** CloudBuilder's cloud (aws | azure | multi) as the form's Platform values. */
export const PLATFORM_MAP: Record<string, readonly string[]> = { aws: ['AWS'], azure: ['Azure'], multi: ['AWS', 'Azure'] };

/** Indian rupees per US dollar, to turn the estimated monthly cloud cost into the form's price (which is in rupees). Set CLOUDBUILDER_NEOZAAR_USD_INR to change it. */
export const DEFAULT_USD_INR = 85;
export const usdInr = (): number => {
  const n = Number(process.env['CLOUDBUILDER_NEOZAAR_USD_INR']);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_INR;
};

/**
 * The keys of `service_solution_details` (the JSON that carries a service's overview, approach, scope, outcome and challenges). CONFIRM these against
 * Neozaar's productOtherDetails model: they follow the names on the Create Service form.
 */
export const SERVICE_DETAIL_KEYS = { overview: 'overview', approach: 'approach', scope: 'scope', outcome: 'outcome', challenges: 'challenges_addressed', coverage: 'coverage' } as const;

export interface CategoryProfile {
  category: string;
  subCategory: string;
  /** False while the mapping is a proposal nobody at Neozaar has confirmed. */
  confirmed: boolean;
  audience: string[];
  segments: string[];
  industries: string[];
  cta: string[];
  /** A short first draft of the business problem. A person should read it before a service is published. */
  challenge: string;
}

const GENERAL = { cta: ['Request Scoping', 'Request Deployment'], segments: ['Enterprise', 'Mid Markets', 'SMB'], audience: ['CTO', 'IT Head', 'DevSecOps Lead'], industries: ['IT_ITES'] };

/** One profile for each of CloudBuilder's template categories. */
export const CATEGORY_PROFILES: Record<string, CategoryProfile> = {
  'Web Applications': { ...GENERAL, category: 'Cloud Infrastructure', subCategory: 'Compute', confirmed: true, challenge: 'Putting a web application on a secure, scalable cloud footprint without designing the network, compute, data and access layers from scratch.' },
  'High Availability': { ...GENERAL, segments: ['Large Enterprise', 'Enterprise', 'Mid Markets'], category: 'Cloud Infrastructure', subCategory: 'Cloud Environments', confirmed: true, challenge: 'Keeping a business application running through the failure of a server or an availability zone, without manual intervention or lost transactions.' },
  'Multi-cloud': { ...GENERAL, segments: ['Large Enterprise', 'Enterprise'], category: 'Cloud Infrastructure', subCategory: 'Cloud Environments', confirmed: true, challenge: 'Running workloads across more than one cloud without lock-in, and with one consistent way to design, secure and operate them.' },
  'Containers / Kubernetes': { ...GENERAL, category: 'Cloud Infrastructure', subCategory: 'Containers', confirmed: true, challenge: 'Standing up a production-grade container platform with sound networking, identity and scaling, without months of platform engineering.' },
  Microservices: { ...GENERAL, category: 'Cloud Infrastructure', subCategory: 'Containers', confirmed: true, challenge: 'Splitting a monolith into independently deployable services while keeping them secure, observable and able to scale on their own.' },
  Serverless: { ...GENERAL, category: 'Cloud Infrastructure', subCategory: 'Compute', confirmed: true, challenge: 'Running event-driven workloads without managing servers, and paying only for what runs.' },
  'Disaster Recovery': { ...GENERAL, audience: ['CIO', 'CTO', 'IT Head', 'Compliance Officers'], segments: ['Large Enterprise', 'Enterprise'], industries: ['BFSI', 'Healthcare', 'Public Sector'], category: 'Protect & Recover Data', subCategory: 'Disaster Recovery', confirmed: true, cta: ['Request Assessment', 'Request Scoping'], challenge: 'Recovering applications and data after a regional outage within agreed recovery time and recovery point targets, without rebuilding by hand.' },
  'Data & Analytics': { ...GENERAL, industries: ['IT_ITES', 'BFSI', 'Retail'], category: 'Adapt AI & Data', subCategory: 'Data Platforms', confirmed: true, challenge: 'Bringing data from many sources into one governed platform where it can be analysed, without building the pipeline and storage layers from scratch.' },
  SaaS: { ...GENERAL, segments: ['ISV', 'Enterprise', 'Mid Markets'], audience: ['CTO', 'DevSecOps Lead', 'IT Head'], industries: ['ISV', 'IT_ITES'], category: 'Cloud Infrastructure', subCategory: 'Cloud Environments', confirmed: false, challenge: 'Delivering a multi-tenant software product that scales with its customers while keeping each customer\'s data isolated and secure.' },
  'E-Commerce': { ...GENERAL, industries: ['E-commerce', 'Retail'], category: 'Cloud Infrastructure', subCategory: 'Compute', confirmed: false, challenge: 'Handling traffic peaks and payments securely on an online store without over-provisioning for the rest of the year.' },
};

/** Used for a template whose category is not one of the above (a custom template an organization saved). */
export const FALLBACK_PROFILE: CategoryProfile = { ...GENERAL, category: 'Cloud Infrastructure', subCategory: 'Cloud Environments', confirmed: false, challenge: '' };
