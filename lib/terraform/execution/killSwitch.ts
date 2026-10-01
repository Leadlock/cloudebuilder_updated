/** Operator kill switch: CLOUDCRAFT_TERRAFORM_DISABLED=1 stops all Terraform plan / apply / destroy immediately. */
export function terraformExecutionDisabled(): boolean {
  return process.env.CLOUDCRAFT_TERRAFORM_DISABLED === '1';
}
