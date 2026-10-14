/**
 * Customers are not told which services run behind CloudCraft (the sign-in directory, the email service, the AI and the price lookups).
 * Error text from those services can still reach a response, for example a message passed through from a failed sign-in, so every error
 * message sent to a browser goes through hideVendorNames. The real text stays in the server log, where the names help with debugging.
 *
 * The customer's own clouds (AWS, Azure, their accounts and resources) are not hidden: they are what the product is about.
 */

/** Longest phrases first, so "Amazon Cognito user pool" becomes one neutral phrase rather than two. */
const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:AWS|Amazon)\s+Cognito(?:\s+User\s+(?:Pool|Directory))?\b/gi, 'the sign-in service'],
  [/\bCognito(?:Identity(?:Provider)?)?(?:ServiceException)?\b/gi, 'sign-in service'],
  [/\buser\s+pool\b/gi, 'directory'],
  [/\b(?:AWS|Amazon)\s+(?:SES|Simple\s+Email\s+Service)(?:\s+Sandbox)?\b/gi, 'the email service'],
  [/\bSES\b/g, 'email service'],
  [/\bAzure\s+(?:AI\s+Foundry|OpenAI)\b/gi, 'the assistant'],
  [/\b(?:AI\s+)?Foundry\b/gi, 'assistant'],
  [/\b(?:Azure\s+)?OpenAI\b/gi, 'assistant'],
  [/\b(?:Amazon\s+)?Bedrock\b/gi, 'assistant'],
  [/\bAnthropic\b/gi, 'assistant'],
  [/\b(?:AWS\s+Price\s+List|Azure\s+Retail\s+Prices)\s+API\b/gi, 'official price list'],
  [/\bPrice\s+List\s+API\b/gi, 'official price list'],
  [/\bRetail\s+Prices\s+API\b/gi, 'official price list'],
];

/** The text with every back-end vendor name replaced by a neutral word. Text without such a name is returned unchanged. */
export function hideVendorNames(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  return out;
}

/** The same, for a value of unknown shape (an error's details): strings are cleaned, arrays and objects are cleaned inside. */
export function hideVendorNamesDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return hideVendorNames(value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => hideVendorNamesDeep(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, hideVendorNamesDeep(v, depth + 1)]));
}
