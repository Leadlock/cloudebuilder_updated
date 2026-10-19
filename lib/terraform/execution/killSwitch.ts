/** Operator kill switch: CLOUDBUILDER_TERRAFORM_DISABLED=1 stops all Terraform plan / apply / destroy immediately. */
export function terraformExecutionDisabled(): boolean {
  return process.env.CLOUDBUILDER_TERRAFORM_DISABLED === '1';
}
