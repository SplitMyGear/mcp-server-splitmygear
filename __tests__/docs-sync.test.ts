/**
 * The tool reference (docs/mcp-tools.md) and the Claude Desktop extension
 * manifest (manifest.json) are GENERATED from the tool registry so they can
 * never drift from what tools/list actually returns. This test fails when
 * they are stale; regenerate with `npm run gen:docs`.
 */
export {};
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { ALL_TOOLS } from '../src/tools/defs';
import type { ToolAccess } from '../src/tools/registry';

const ROOT = path.join(__dirname, '..');
const UPDATE = process.env.UPDATE_DOCS === '1';

const ACCESS_LABEL: Record<ToolAccess, string> = {
  public: 'Public (any credential)',
  user: 'Signed-in user',
  renter: 'Renter',
  vendor: 'Vendor',
  vendor_finance: 'Vendor owner/manager',
  vendor_owner: 'Vendor owner',
};

function describeShape(shape: Record<string, z.ZodTypeAny>): string {
  const entries = Object.entries(shape);
  if (entries.length === 0) return '_none_';
  return entries
    .map(([name, schema]) => {
      const optional = schema.isOptional();
      const desc = schema.description ? ` ${schema.description}` : '';
      return `\`${name}\`${optional ? '' : ' (required)'}${desc}`;
    })
    .join('<br>');
}

function renderMarkdown(): string {
  const groups = new Map<ToolAccess, typeof ALL_TOOLS>();
  for (const t of ALL_TOOLS) groups.set(t.access, [...(groups.get(t.access) ?? []), t]);
  const order: ToolAccess[] = ['public', 'user', 'renter', 'vendor', 'vendor_finance', 'vendor_owner'];
  let md = `# Splitt MCP Server: tool reference\n\n`;
  md += `_Generated from the tool registry by \`npm run gen:docs\`. Do not edit by hand._\n\n`;
  md += `${ALL_TOOLS.length} tools. The tool list a client sees is filtered by who is signed in: the operator API key sees only the public tools; a renter, vendor seat or owner sees the sections that apply to them. Every user-scoped call forwards the signed-in user's own Splitt session to the backend, which enforces ownership and permissions.\n\n`;
  for (const access of order) {
    const tools = groups.get(access);
    if (!tools?.length) continue;
    md += `## ${ACCESS_LABEL[access]}\n\n`;
    md += `| Tool | What it does | Arguments |\n|---|---|---|\n`;
    for (const t of tools) {
      const flags = [t.annotations.readOnlyHint ? 'read-only' : t.annotations.destructiveHint ? 'destructive' : 'write'];
      md += `| \`${t.name}\`<br>_${t.title}_ (${flags.join(', ')}) | ${t.description.replace(/\|/g, '\\|')} | ${describeShape(t.inputSchema as Record<string, z.ZodTypeAny>).replace(/\|/g, '\\|')} |\n`;
    }
    md += `\n`;
  }
  md += `## Resources\n\n| URI | Description |\n|---|---|\n| \`splitmygear://categories\` | The 19 canonical Title-Case gear categories |\n`;
  return md;
}

function renderManifestTools(): Array<{ name: string; description: string }> {
  return ALL_TOOLS.map((t) => ({ name: t.name, description: t.title }));
}

describe('generated docs are in sync with the tool registry', () => {
  it('docs/mcp-tools.md', () => {
    const file = path.join(ROOT, 'docs', 'mcp-tools.md');
    const expected = renderMarkdown();
    if (UPDATE) fs.writeFileSync(file, expected);
    expect(fs.readFileSync(file, 'utf8')).toBe(expected);
  });

  it('manifest.json tools', () => {
    const file = path.join(ROOT, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expected = renderManifestTools();
    if (UPDATE) {
      manifest.tools = expected;
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).tools).toEqual(expected);
  });
});
