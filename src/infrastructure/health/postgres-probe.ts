import type { EntityManager } from '@mikro-orm/postgresql';
import { ReadinessProbe } from '../../application/ports/readiness-probe.port.js';

// Um `SELECT 1` de verdade, numa conexão do pool, com prazo. Se o pool estiver todo ocupado ou o
// banco caído, falha: é isso que "pronto" quer dizer (o serviço não conseguiria atender).
export class PostgresProbe extends ReadinessProbe {
  readonly name = 'postgres';

  constructor(
    private readonly em: EntityManager,
    private readonly timeoutMs = 2_000,
  ) {
    super();
  }

  async isUp(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.em.getConnection().execute('select 1'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout')),
            this.timeoutMs,
          );
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
