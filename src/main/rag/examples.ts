import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Collection } from '@shared/types'
import type { Ctx } from '../core/context'
import type { SettingsService } from '../core/settings'
import type { RagService } from './rag'

export const EXAMPLES_COLLECTION = 'Cloth examples'

/** Bundled example knowledge: seeded once on first run, re-loadable from the Knowledge page. */
export class ExamplesService {
  constructor(
    private ctx: Ctx,
    private rag: RagService,
    private settings: SettingsService
  ) {}

  files(): string[] {
    if (!existsSync(this.ctx.examplesDir)) return []
    return readdirSync(this.ctx.examplesDir)
      .filter((f) => /\.(md|txt)$/i.test(f))
      .map((f) => join(this.ctx.examplesDir, f))
  }

  /** Create/refresh the examples collection. Unchanged files are skipped by content hash. */
  async load(): Promise<Collection | null> {
    const files = this.files()
    if (!files.length) return null
    const col =
      this.rag.findCollection(EXAMPLES_COLLECTION) ??
      this.rag.createCollection({
        name: EXAMPLES_COLLECTION,
        description: 'Bundled sample docs: the Cloth user guide plus Git, HTTP/REST, regex, cron and SQL references'
      })
    await this.rag.ingestPaths(col.id, files)
    this.settings.update({ examplesLoaded: true })
    return this.rag.getCollection(col.id)
  }

  /** First-run seeding; never re-seeds after the user deletes the collection. */
  async seedIfNeeded(): Promise<void> {
    if (this.settings.get().examplesLoaded) return
    try {
      await this.load()
    } catch (err) {
      this.ctx.log('examples', 'seeding failed', err)
    }
  }
}
