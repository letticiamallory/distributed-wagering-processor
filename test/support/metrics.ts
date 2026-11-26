// Lê o texto do Prometheus (a saída de /metrics ou do registro) como { "nome{rótulos}": valor }.
export function parseMetrics(text: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const at = line.lastIndexOf(' ');
    found[line.slice(0, at)] = Number(line.slice(at + 1));
  }
  return found;
}

export interface Renderable {
  render(): Promise<string>;
}

// O valor de UMA série (0 se ela ainda não existe, como o Prometheus a trataria).
export async function metric(
  source: Renderable,
  series: string,
): Promise<number> {
  return parseMetrics(await source.render())[series] ?? 0;
}
