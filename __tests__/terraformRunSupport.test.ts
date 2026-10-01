import { initWithRetry, isTransientNetworkError, validateConfiguration, type RunTerraform } from '@/lib/terraform/execution/runSupport';

const DNS = 'terraform init failed (exit 1): Error: Failed to query available provider packages: dial tcp: lookup registry.terraform.io: getaddrinfow: temporary error';
const noWait = async () => undefined;

describe('isTransientNetworkError', () => {
  it('recognises network drops and nothing else', () => {
    for (const m of [DNS, 'read tcp: connection reset by peer', 'net/http: TLS handshake timeout', 'no such host', 'i/o timeout']) expect(isTransientNetworkError(m)).toBe(true);
    for (const m of ['Error: Invalid reference', 'AuthorizationFailed', 'Resource Group still contains Resources']) expect(isTransientNetworkError(m)).toBe(false);
  });
});

describe('initWithRetry', () => {
  it('succeeds first time without waiting', async () => {
    const run = jest.fn<ReturnType<RunTerraform>, Parameters<RunTerraform>>().mockResolvedValue({ stdout: '', stderr: '' });
    const sleep = jest.fn(async (_ms: number) => undefined);
    await initWithRetry('/tmp/x', {}, { run, sleep });
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(run.mock.calls[0]![0]).toEqual(['init', '-input=false', '-no-color']);
    expect(run.mock.calls[0]![1].pluginCache).toBe(true);
  });

  it('retries a network drop with a growing wait, then succeeds, and tells the live log', async () => {
    const run = jest.fn<ReturnType<RunTerraform>, Parameters<RunTerraform>>().mockRejectedValueOnce(new Error(DNS)).mockRejectedValueOnce(new Error(DNS)).mockResolvedValue({ stdout: '', stderr: '' });
    const sleep = jest.fn(async (_ms: number) => undefined);
    const log: string[] = [];
    await initWithRetry('/tmp/x', {}, { run, sleep, onOutput: (c) => log.push(c) });
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([4000, 8000]);
    expect(log.join('')).toMatch(/Network problem during init \(attempt 1 of 3\)/);
  });

  it('gives up after the allowed attempts and throws the last error', async () => {
    const run = jest.fn<ReturnType<RunTerraform>, Parameters<RunTerraform>>().mockRejectedValue(new Error(DNS));
    await expect(initWithRetry('/tmp/x', {}, { run, sleep: noWait, attempts: 3 })).rejects.toThrow(/getaddrinfow/);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error that is not a network problem', async () => {
    const run = jest.fn<ReturnType<RunTerraform>, Parameters<RunTerraform>>().mockRejectedValue(new Error('terraform init failed (exit 1): Error: Unsupported block type'));
    await expect(initWithRetry('/tmp/x', {}, { run, sleep: noWait })).rejects.toThrow(/Unsupported block type/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries once WITHOUT the shared provider cache when the cache misbehaves', async () => {
    const run = jest.fn<ReturnType<RunTerraform>, Parameters<RunTerraform>>().mockRejectedValueOnce(new Error('Error: the cached package does not match any of the checksums recorded in the dependency lock file')).mockResolvedValue({ stdout: '', stderr: '' });
    await initWithRetry('/tmp/x', {}, { run, sleep: noWait });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![1].pluginCache).toBe(true);
    expect(run.mock.calls[1]![1].pluginCache).toBe(false);
  });
});

describe('validateConfiguration', () => {
  it('passes quietly when Terraform accepts the files', async () => {
    const run = jest.fn<ReturnType<RunTerraform>, Parameters<RunTerraform>>().mockResolvedValue({ stdout: 'Success!', stderr: '' });
    await expect(validateConfiguration('/tmp/x', {}, { run })).resolves.toBeUndefined();
    expect(run.mock.calls[0]![0]).toEqual(['validate', '-no-color']);
  });

  it('turns a rejection into a clear error that says nothing was changed, keeping Terraform\'s detail', async () => {
    const run: RunTerraform = async () => { throw new Error('terraform validate failed (exit 1): Error: Reference to undeclared resource on outputs.tf line 3'); };
    await expect(validateConfiguration('/tmp/x', {}, { run })).rejects.toThrow(/rejected the generated configuration \(nothing was changed\): Error: Reference to undeclared resource on outputs\.tf line 3/);
  });
});
