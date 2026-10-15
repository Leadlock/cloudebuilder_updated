/** Small pieces several of the Container Templates generators and validators use, defined once so they cannot drift apart. */

/** A YAML double-quoted string: only backslash and quote need escaping. */
export const yq = (s: string): string => `"${s.replace(/[\\"]/g, (m) => `\\${m}`)}"`;

/** An AWS region such as us-east-1. */
export const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

/** An Azure location such as westeurope or eastus2. */
export const LOCATION = /^[a-z]{3,}[a-z0-9]*$/;
