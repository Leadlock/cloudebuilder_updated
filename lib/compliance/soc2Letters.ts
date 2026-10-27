/**
 * Template letters the CPA firm usually asks for. CloudBuilder drafts them as a convenience; management (or the provider) reviews, edits and signs. CloudBuilder never signs,
 * and the CPA firm confirms the final wording. Anything not known is left in square brackets.
 */
import { SOC2_CATEGORY_LABEL } from './soc2/criteria';
import type { ReadinessReport } from './report';

const dateLong = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function bridgeLetter(r: ReadinessReport): string[] {
  return [
    '[Provider or company letterhead]',
    `To: ${r.company} and [CPA firm name]`,
    'Date: [DD Month YYYY]',
    'Subject: Bridge letter for [gap start date] to [gap end date], covering [service name]',
    '',
    'We confirm that between [gap start date] and [gap end date] we have [not] become aware of:',
    '(1)  any material change to the design of the controls described in our SOC 2 report for the period [report start] to [report end];',
    '(2)  any incident that affected the security, availability or confidentiality of the service, or the data of its customers;',
    '(3)  any failure of a control described in that report, or any exception we have not already reported to you;',
    '(4)  any change to our subservice organisations that affects the controls described in that report.',
    '',
    'If any of these has occurred, we describe it here: [description, date, effect, and action taken].',
    '',
    'This letter covers only the period named above. It is not a SOC 2 report and it is not an opinion. It is given so that your examination of [system name] can rely on our report across the whole period.',
    '',
    'Signed: [name and title]          Date: [DD Month YYYY]',
    '',
    'Use a bridge letter when a provider\'s report, or the company\'s own report, does not cover the whole audit period. The provider or the company signs it. CloudBuilder does not.',
  ];
}

export function representationLetter(r: ReadinessReport): string[] {
  const cats = r.categories.map((c) => SOC2_CATEGORY_LABEL[c]).join(', ');
  return [
    '[Company letterhead]',
    'To: [CPA firm name]',
    'Date: [DD Month YYYY]',
    '',
    `In connection with your examination of the description of ${r.system.name}, and of the suitability of the design of its controls as of ${dateLong(r.asOf)}, relevant to the trust services criteria for ${cats}, we confirm, to the best of our knowledge and belief, the following.`,
    '',
    'a.  We are responsible for the description, for our assertion, and for the design, implementation and operation of the controls.',
    'b.  We have given you all information relevant to the engagement, including access to records, personnel and documents.',
    'c.  The description fairly presents the system as it was designed and implemented on the date above, and does not omit or distort relevant information.',
    'd.  We have told you of any significant changes to the system, its services, providers, people or controls up to the date of this letter.',
    'e.  We have told you of any security incidents, and of any instance of non-compliance with laws or regulations or with our commitments to customers, that bear on the examination.',
    'f.  We have told you of any known deficiency in the design of the controls, and of any finding from our own assessment, including those not yet remediated.',
    'g.  We have told you of the complementary user entity controls and the services of subservice organisations that the description relies on.',
    'h.  No event has occurred since the date above that would materially change what we have told you, except as follows: [events, or "none"].',
    '',
    'Signed: [name and title of the person responsible]          Date: [DD Month YYYY]',
    '',
    'The CPA firm will ask management for a representation letter and confirms the final wording and any further representations it requires. Management reviews, edits and signs it. CloudBuilder does not.',
  ];
}
