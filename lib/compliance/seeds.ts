/** The complementary controls the report suggests (the team confirms, edits or adds to them). Shared by the report and the form, so the ids always agree. */
export const CUEC_SEEDS: Array<[string, string]> = [
  ['Customers keep their own sign-in credentials secure and use a second factor where offered.', 'CC6.1, CC6.2'], ['Customers review the access given to their own users and remove it when it is no longer needed.', 'CC6.1, CC6.2'],
  ['Customers tell the company promptly about suspected security incidents affecting their data.', 'CC7.3'], ['Customers configure the service as the documentation describes.', 'CC2.3'],
];
export const CSOC_SEEDS: Array<[string, string]> = [
  ['Physical access to the data centres is controlled by the provider.', 'CC6.4'], ["Power, cooling and network connectivity of the data centres are the provider's responsibility.", 'A1.2'],
  ['The underlying host and virtualization layer is secured and patched by the provider.', 'CC6.6, CC7.1'],
];
