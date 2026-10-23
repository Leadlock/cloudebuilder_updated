/**
 * High-performance pure TypeScript Rego/OPA policy evaluation engine.
 * Evaluates OPA rules against Terraform plans, Canvas architecture, and Cost projections
 * without requiring an external OPA daemon or Go runtime.
 */

import type { OpaEvaluationInput, OpaEvaluationResult, OpaPolicyDefinition, OpaViolation } from './types';

interface RuleBlock {
  severity: 'deny' | 'warn' | 'info';
  msgExpr: string;
  body: string;
}

function extractRuleBlocks(code: string): RuleBlock[] {
  const blocks: RuleBlock[] = [];
  const headRegex = /\b(deny|warn|info)\s*\[/g;
  let match: RegExpExecArray | null;

  while ((match = headRegex.exec(code)) !== null) {
    const severity = match[1] as 'deny' | 'warn' | 'info';
    let idx = headRegex.lastIndex; // right after '['
    let depth = 1;
    let msgExpr = '';
    while (idx < code.length && depth > 0) {
      const char = code[idx];
      if (char === '[') depth++;
      else if (char === ']') depth--;
      if (depth > 0) msgExpr += char;
      idx++;
    }

    const openBrace = code.indexOf('{', idx);
    if (openBrace === -1) continue;
    let bDepth = 1;
    let bIdx = openBrace + 1;
    let body = '';
    while (bIdx < code.length && bDepth > 0) {
      const char = code[bIdx];
      if (char === '{') bDepth++;
      else if (char === '}') bDepth--;
      if (bDepth > 0) body += char;
      bIdx++;
    }
    blocks.push({ severity, msgExpr: msgExpr.trim(), body: body.trim() });
    headRegex.lastIndex = bIdx;
  }
  return blocks;
}

export class RegoInterpreter {
  public evaluatePolicy(policy: OpaPolicyDefinition, input: OpaEvaluationInput): OpaViolation[] {
    if (!policy.enabled) return [];

    const violations: OpaViolation[] = [];
    const blocks = extractRuleBlocks(policy.regoCode);

    for (const block of blocks) {
      const hits = this.evaluateRuleBody(block.body, block.msgExpr, input, policy);
      violations.push(...hits.map((h) => ({ ...h, severity: policy.severity || block.severity })));
    }

    return violations;
  }

  private evaluateRuleBody(
    body: string,
    msgExpr: string,
    input: OpaEvaluationInput,
    policy: OpaPolicyDefinition,
  ): OpaViolation[] {
    const lines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    const usesPlanChanges = lines.some((l) => l.includes('input.plan.resource_changes') || l.startsWith('rc.') || l.includes('rc.'));
    const usesCanvasNodes = lines.some((l) => l.includes('input.canvas.nodes') || l.startsWith('node.') || l.includes('node.'));
    const usesCost = lines.some((l) => l.includes('input.cost') || l.startsWith('cost.') || l.includes('cost.'));

    const violations: OpaViolation[] = [];

    if (usesPlanChanges) {
      const changes = input.plan?.resource_changes || [];
      for (const rc of changes) {
        const ctx: Record<string, any> = { input, rc, change: rc.change, after: rc.change?.after || {} };
        if (this.evalConditions(lines, ctx)) {
          const message = this.interpolateMessage(msgExpr, ctx, policy.name);
          violations.push({
            id: policy.id,
            ruleTitle: policy.name,
            severity: policy.severity,
            category: policy.category,
            resourceAddress: rc.address,
            resourceType: rc.type,
            message,
            remediation: `Review ${rc.address} (${rc.type}) to comply with ${policy.name}`,
          });
        }
      }
      return violations;
    }

    if (usesCanvasNodes) {
      const nodes = input.canvas?.nodes || [];
      for (const node of nodes) {
        const ctx: Record<string, any> = { input, node, config: node.config || {} };
        if (this.evalConditions(lines, ctx)) {
          const message = this.interpolateMessage(msgExpr, ctx, policy.name);
          violations.push({
            id: policy.id,
            ruleTitle: policy.name,
            severity: policy.severity,
            category: policy.category,
            resourceAddress: node.label || node.id,
            resourceType: node.resourceType,
            message,
            remediation: `Update canvas configuration for ${node.label} to satisfy ${policy.name}`,
          });
        }
      }
      return violations;
    }

    if (usesCost) {
      const ctx: Record<string, any> = { input, cost: input.cost || { monthlyTotalUsd: 0, deltaMonthlyUsd: 0 } };
      if (this.evalConditions(lines, ctx)) {
        const message = this.interpolateMessage(msgExpr, ctx, policy.name);
        violations.push({
          id: policy.id,
          ruleTitle: policy.name,
          severity: policy.severity,
          category: policy.category,
          message,
          remediation: `Adjust resource sizing or apply reserved pricing to keep cost within policy limits.`,
        });
      }
      return violations;
    }

    // General condition
    const generalCtx: Record<string, any> = { input };
    if (this.evalConditions(lines, generalCtx)) {
      const message = this.interpolateMessage(msgExpr, generalCtx, policy.name);
      violations.push({
        id: policy.id,
        ruleTitle: policy.name,
        severity: policy.severity,
        category: policy.category,
        message,
        remediation: `Ensure architecture inputs satisfy ${policy.name}`,
      });
    }

    return violations;
  }

  private evalConditions(lines: string[], ctx: Record<string, any>): boolean {
    for (const rawLine of lines) {
      const line = rawLine.trim().replace(/;$/, '');
      if (!line || line.startsWith('rc :=') || line.startsWith('node :=') || line.startsWith('cost :=') || line.startsWith('msg :=')) {
        continue;
      }

      if (!this.evalSingleCondition(line, ctx)) {
        return false;
      }
    }
    return true;
  }

  private evalSingleCondition(expr: string, ctx: Record<string, any>): boolean {
    // Check regex match: regex.match(pattern, target)
    const regexMatch = /regex\.match\((['"`])([^'"`]+)\1,\s*([^)]+)\)/.exec(expr);
    if (regexMatch) {
      const pattern = new RegExp(regexMatch[2]);
      const targetVal = String(this.evalOperand(regexMatch[3], ctx) ?? '');
      return pattern.test(targetVal);
    }

    // Check contains(str, substr)
    const containsMatch = /contains\(([^,]+),\s*(['"`])([^'"`]+)\2\)/.exec(expr);
    if (containsMatch) {
      const strVal = String(this.evalOperand(containsMatch[1], ctx) ?? '');
      return strVal.includes(containsMatch[3]);
    }

    // Comparison operators: ==, !=, >=, <=, >, <
    const compRegex = /^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.*?)$/;
    const comp = compRegex.exec(expr);
    if (comp) {
      const leftExpr = comp[1].trim();
      const op = comp[2];
      const rightExpr = comp[3].trim();

      // Check if leftExpr is an array wildcard reference: foo.bar[_]
      if (leftExpr.includes('[_]')) {
        const arrayFieldPath = leftExpr.replace('[_]', '');
        const arrayVal = this.evalOperand(arrayFieldPath, ctx);
        const rightVal = this.evalOperand(rightExpr, ctx);
        if (!Array.isArray(arrayVal)) return false;

        switch (op) {
          case '==':
            return arrayVal.some((item) => item == rightVal);
          case '!=':
            return arrayVal.every((item) => item != rightVal);
          case '>':
            return arrayVal.some((item) => Number(item) > Number(rightVal));
          case '<':
            return arrayVal.some((item) => Number(item) < Number(rightVal));
          case '>=':
            return arrayVal.some((item) => Number(item) >= Number(rightVal));
          case '<=':
            return arrayVal.some((item) => Number(item) <= Number(rightVal));
        }
      }

      const left = this.evalOperand(leftExpr, ctx);
      const right = this.evalOperand(rightExpr, ctx);

      switch (op) {
        case '==':
          return left == right;
        case '!=':
          return left != right;
        case '>':
          return Number(left) > Number(right);
        case '<':
          return Number(left) < Number(right);
        case '>=':
          return Number(left) >= Number(right);
        case '<=':
          return Number(left) <= Number(right);
      }
    }

    // Boolean check or truthy presence
    const val = this.evalOperand(expr, ctx);
    return Boolean(val);
  }

  private evalOperand(token: string, ctx: Record<string, any>): any {
    token = token.trim();

    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }

    if (/^-?\d+(\.\d+)?$/.test(token)) {
      return Number(token);
    }

    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;

    const parts = token.split('.');
    const baseVar = parts[0];

    if (baseVar in ctx) {
      let current = ctx[baseVar];
      for (let i = 1; i < parts.length; i++) {
        if (current === undefined || current === null) return undefined;
        const part = parts[i].replace('[_]', '');
        current = current[part];
      }
      return current;
    }

    if (token.startsWith('input.')) {
      const subParts = token.replace('input.', '').split('.');
      let current = ctx.input;
      for (const p of subParts) {
        if (current === undefined || current === null) return undefined;
        current = current[p.replace('[_]', '')];
      }
      return current;
    }

    return undefined;
  }

  private interpolateMessage(expr: string, ctx: Record<string, any>, fallback: string): string {
    const sprintfMatch = /sprintf\((['"`])([^'"`]+)\1,\s*\[([^\]]*)\]\)/.exec(expr);
    if (sprintfMatch) {
      let template = sprintfMatch[2];
      const rawArgs = sprintfMatch[3].split(',').map((s) => s.trim()).filter(Boolean);
      for (const arg of rawArgs) {
        const val = this.evalOperand(arg, ctx) ?? '';
        template = template.replace(/%[vsfd]/, String(val));
      }
      return template;
    }

    if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
      return expr.slice(1, -1);
    }

    return fallback;
  }
}

export async function evaluateOpaPolicies(
  policies: OpaPolicyDefinition[],
  input: OpaEvaluationInput,
): Promise<OpaEvaluationResult> {
  const startTime = Date.now();
  const interpreter = new RegoInterpreter();

  const allViolations: OpaViolation[] = [];
  let evaluatedCount = 0;

  for (const policy of policies) {
    if (!policy.enabled) continue;
    evaluatedCount++;
    try {
      const violations = interpreter.evaluatePolicy(policy, input);
      allViolations.push(...violations);
    } catch (err) {
      console.warn(`[regoEngine] Failed to evaluate policy ${policy.id}:`, err);
    }
  }

  const violations = allViolations.filter((v) => v.severity === 'deny');
  const warnings = allViolations.filter((v) => v.severity === 'warn');
  const infos = allViolations.filter((v) => v.severity === 'info');

  return {
    passed: violations.length === 0,
    violations,
    warnings,
    infos,
    rulesEvaluated: evaluatedCount,
    durationMs: Date.now() - startTime,
    evaluatedAt: new Date().toISOString(),
  };
}
