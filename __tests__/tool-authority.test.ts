import fs from 'fs';
import path from 'path';
import { ALL_TOOLS } from '@/tools/defs';
import { isToolAllowed, type ToolContext } from '@/tools/registry';

/**
 * SPLIT-1207: docs/tool-authority.md is the per-tool record of what the server
 * can do on the backend, generated from the registry so it cannot drift. After
 * adding or changing a tool, regenerate it:
 *   UPDATE_TOOL_AUTHORITY=1 npx jest __tests__/tool-authority.test.ts
 */
const DOC = path.join(process.cwd(), 'docs/tool-authority.md');
const MARKER = '<!-- generated: tool table -->';

function toolTable(): string {
  const rows = [...ALL_TOOLS]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const writes = tool.annotations.readOnlyHint === true ? 'read' : 'write';
      const destructive = tool.annotations.destructiveHint === true ? ' (destructive)' : '';
      return `| \`${tool.name}\` | ${tool.access} | ${tool.scope} | ${writes}${destructive} |`;
    });
  return ['| Tool | Access | Scope | Effect |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('per-tool backend authority (SPLIT-1207)', () => {
  it('docs/tool-authority.md matches the registry', () => {
    const doc = fs.readFileSync(DOC, 'utf8');
    const head = doc.slice(0, doc.indexOf(MARKER) + MARKER.length);
    const expected = `${head}\n\n${toolTable()}\n`;
    if (process.env.UPDATE_TOOL_AUTHORITY) fs.writeFileSync(DOC, expected);
    expect(fs.readFileSync(DOC, 'utf8')).toBe(expected);
  });

  it('no tool reads a server secret, so a tool can only use the caller token it is handed', () => {
    const offenders = sourceFiles(path.join(process.cwd(), 'src/tools')).filter((file) =>
      fs.readFileSync(file, 'utf8').includes('process.env'),
    );
    expect(offenders).toEqual([]);
  });

  it('the operator key reaches public tools only, whatever role it reports', () => {
    const operator: ToolContext = { role: 'admin', kind: 'operator', scopes: ['read'] };
    const reachable = ALL_TOOLS.filter((tool) => isToolAllowed(tool, operator));
    expect(reachable.length).toBeGreaterThan(0);
    expect(reachable.filter((tool) => tool.access !== 'public')).toEqual([]);
    expect(reachable.filter((tool) => tool.annotations.readOnlyHint !== true).map((t) => t.name)).toEqual([]);
  });

  it('every non-public tool is hidden from a principal with no backend token', () => {
    const tokenless: ToolContext = { role: 'admin' };
    const hidden = ALL_TOOLS.filter((tool) => tool.access !== 'public');
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.filter((tool) => isToolAllowed(tool, tokenless)).map((t) => t.name)).toEqual([]);
  });
});
