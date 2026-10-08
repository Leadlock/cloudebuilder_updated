/**
 * Diagnostic tool to verify Azure AI Foundry configuration & connectivity
 * Run on localhost or on your Hostinger server:
 *   npx tsx scripts/test-foundry-connection.ts
 */
import { foundryClient, FOUNDRY_MODEL, foundryBaseURL } from '../lib/ai/foundryClient.js';

async function testAzureFoundry() {
  console.log('--- CloudCraft Azure AI Foundry Diagnostic ---');
  
  const endpoint = process.env.AZURE_AI_FOUNDRY_ENDPOINT;
  const key = process.env.AZURE_AI_FOUNDRY_API_KEY;
  const deployment = process.env.AZURE_AI_FOUNDRY_DEPLOYMENT || FOUNDRY_MODEL;

  console.log(`Endpoint Configured: ${endpoint ? '✓ Present' : '✗ Missing'}`);
  console.log(`API Key Configured:  ${key ? '✓ Present' : '✗ Missing'}`);
  console.log(`Deployment Name:     ${deployment}`);
  console.log(`Base URL:            ${foundryBaseURL() || '(none)'}`);

  if (!endpoint || !key) {
    console.error('\n[ERROR] Missing Azure AI Foundry credentials in .env!');
    console.error('Make sure AZURE_AI_FOUNDRY_ENDPOINT and AZURE_AI_FOUNDRY_API_KEY are set in your server environment.');
    process.exit(1);
  }

  console.log('\nTesting connection to Azure AI Foundry...');
  try {
    const startTime = Date.now();
    const response = await foundryClient().responses.create({
      model: deployment,
      input: [
        { role: 'system', content: 'You are an AI assistant.' },
        { role: 'user', content: 'Respond with a simple JSON object: {"status": "ok", "message": "connected"}' },
      ],
      text: { format: { type: 'json_object' } },
    });

    const elapsed = Date.now() - startTime;
    console.log(`✓ Connection Successful! Response time: ${elapsed}ms`);
    console.log('Response Output:', response.output_text || response);
    console.log('\n[SUCCESS] Azure AI Foundry is fully working and reachable from this environment.');
  } catch (err: any) {
    console.error('\n[FAILED] Azure AI Foundry connection failed with error:');
    console.error(err?.message || err);

    if (err?.status === 401 || err?.message?.includes('401') || err?.message?.includes('Unauthorized')) {
      console.error('\nPossible Cause: AZURE_AI_FOUNDRY_API_KEY is incorrect or expired.');
    } else if (err?.status === 403 || err?.message?.includes('403') || err?.message?.includes('Forbidden')) {
      console.error('\nPossible Cause: Azure AI Foundry Firewall/Networking blocked this server IP.');
      console.error('Action: In Azure Portal -> AI Foundry / OpenAI resource -> Networking, allow "All networks" or add Hostinger server IP.');
    } else if (err?.status === 404 || err?.message?.includes('404') || err?.message?.includes('NotFound')) {
      console.error(`\nPossible Cause: Deployment "${deployment}" was not found in this Azure AI resource.`);
      console.error('Action: Verify the deployment name in Azure AI Foundry Studio -> Deployments.');
    } else if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND') {
      console.error('\nPossible Cause: Outbound network/firewall issue or invalid domain endpoint.');
    }
    process.exit(1);
  }
}

testAzureFoundry();
