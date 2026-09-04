/**
 * Process-local image drafts and their Harness-owned admission boundary.
 *
 * A draft deliberately retains a user-facing path, not bytes or an attachment
 * reference. The current session's filesystem resolves and reads it only when
 * the message is sent; the attachment store then validates and durably commits
 * the complete ordered batch before any `ImageBlock` enters the Agent inbox.
 * @module dshline/image-drafts
 */

import { basename, extname } from 'node:path'
import type { AttachmentStore, EncodedImageAttachment, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

/** A path staged for the current session's next ordinary prompt. */
export interface ImageDraft {
  /** Path in the session filesystem's vocabulary; never persisted by dshline. */
  readonly path: string
  /** Declared type inferred from the explicit raster suffix and verified by Harness. */
  readonly mediaType: ImageMediaType
  /** Basename-only display metadata handed to the attachment store. */
  readonly name: string
}

/** Result of trying to add one local path to the current draft. */
export type StageImageResult =
  | { readonly ok: true; readonly draft: ImageDraft }
  | { readonly ok: false; readonly reason: 'empty' | 'unsupported-type' | 'deployment-type' | 'too-many' | 'duplicate' }

/** Authoritative deployment facts usable before bytes are read. */
export interface ImageDraftPolicy {
  /** Maximum images in one message. */
  readonly maxImages: number
  /** Raster types this attachment provider currently admits. */
  readonly mediaTypes: readonly ImageMediaType[]
}

/** Raster suffixes represented by Harness's version-one attachment contract. */
const IMAGE_TYPES: Readonly<Record<string, ImageMediaType>> = Object.freeze({
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
})

/**
 * Remove the optional mention sigil and one matching quote pair.
 *
 * The whole command remainder is one path, so spaces need no shell escaping.
 * Quotes are accepted only as outer presentation; backslashes remain path
 * characters because dshline must not invent a shell grammar over filesystem
 * names.
 * @param raw - text following `/image`.
 * @returns the path text, trimmed only at its outer boundary.
 */
export function imagePath(raw: string): string {
  let value = raw.trim()
  if (value.startsWith('@')) value = value.slice(1)
  if (value.length >= 2) {
    const first = value[0]
    if ((first === '"' || first === "'") && value.at(-1) === first) value = value.slice(1, -1)
  }
  return value
}

/**
 * Infer the only attachment kind Harness currently accepts.
 *
 * This is admission routing, not validation: the attachment store fully
 * decodes the bytes and rejects a false or mismatched suffix at send time.
 * @param path - path in the mounted filesystem's vocabulary.
 * @returns the declared raster media type, or undefined for a non-image suffix.
 */
export function imageMediaType(path: string): ImageMediaType | undefined {
  return IMAGE_TYPES[extname(path).toLocaleLowerCase('en-US')]
}

/** Session-scoped collection of unsent image paths. */
export class ImageDrafts {
  private readonly entries: ImageDraft[] = []

  /** Current drafts in submission order. */
  get items(): readonly ImageDraft[] {
    return this.entries
  }

  /** Number of images waiting for the next ordinary prompt. */
  get size(): number {
    return this.entries.length
  }

  /**
   * Stage one path without reading it or creating durable attachment objects.
   * @param raw - full command argument, optionally beginning with `@`.
   * @returns the accepted draft or a stable refusal reason.
   */
  stage(raw: string, policy?: ImageDraftPolicy): StageImageResult {
    const path = imagePath(raw)
    if (path === '') return { ok: false, reason: 'empty' }
    const mediaType = imageMediaType(path)
    if (mediaType === undefined) return { ok: false, reason: 'unsupported-type' }
    if (policy !== undefined && !policy.mediaTypes.includes(mediaType)) {
      return { ok: false, reason: 'deployment-type' }
    }
    if (policy !== undefined && this.entries.length >= policy.maxImages) {
      return { ok: false, reason: 'too-many' }
    }
    if (this.entries.some(entry => entry.path === path)) return { ok: false, reason: 'duplicate' }
    const draft = { path, mediaType, name: basename(path) }
    this.entries.push(draft)
    return { ok: true, draft }
  }

  /** Remove every unsent path, leaving no durable object behind. */
  clear(): void {
    this.entries.length = 0
  }

  /**
   * Remove one draft by its one-based user-facing position.
   * @param position - number shown by `/image`.
   * @returns the removed draft, or undefined when the position does not exist.
   */
  remove(position: number): ImageDraft | undefined {
    if (!Number.isSafeInteger(position) || position < 1 || position > this.entries.length) return undefined
    return this.entries.splice(position - 1, 1)[0]
  }
}

/**
 * Read and durably admit one complete draft batch through Harness services.
 *
 * Reads are individually bounded by the deployment's authoritative per-image
 * limit. `saveImages` owns aggregate/count checks, full decode, normalization,
 * and all-or-no-references batch publication.
 * @param drafts - ordered process-local paths.
 * @param fs - current session's filesystem authority.
 * @param attachments - durable Harness attachment authority.
 * @param cwd - current session workspace for relative paths.
 * @param signal - cancellation shared by resolution and bounded reads.
 * @returns durable image blocks in draft order.
 */
export async function admitImageDrafts(
  drafts: readonly ImageDraft[],
  fs: FileSystem,
  attachments: AttachmentStore,
  cwd: string,
  signal?: AbortSignal,
): Promise<readonly ImageBlock[]> {
  const inputs = await readImageDrafts(drafts, fs, cwd, attachments.imageLimits.maxImageBytes, signal)
  const refs = await attachments.saveImages(inputs)
  return refs.map(attachment => ({ type: 'image', attachment }))
}

/**
 * Resolve and read draft paths through the current filesystem under a hard cap.
 * @param drafts - ordered process-local paths.
 * @param fs - current session's filesystem authority.
 * @param cwd - current session workspace for relative paths.
 * @param maxBytes - inclusive bound for each complete read.
 * @param signal - optional cancellation shared by resolution and reads.
 * @returns raw, bounded inputs suitable for an authoritative Harness consumer.
 */
export async function readImageDrafts(
  drafts: readonly ImageDraft[],
  fs: FileSystem,
  cwd: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<readonly SaveImageAttachment[]> {
  signal?.throwIfAborted()
  const inputs: SaveImageAttachment[] = []
  for (const draft of drafts) {
    const target = await fs.resolve(draft.path, { cwd, ...(signal === undefined ? {} : { signal }) })
    const data = await fs.readBytes(target, signal, maxBytes)
    inputs.push({ data, mediaType: draft.mediaType, name: draft.name })
  }
  return inputs
}

/**
 * Serialize bounded draft inputs for the command registry's composer envelope.
 *
 * Base64 exists only at this immediate call boundary; dshline never stores or
 * logs it. The registry decodes, validates, and durably admits the batch before
 * an attachment-authorized command handler runs.
 * @param inputs - bounded bytes read from the mounted filesystem.
 * @returns ordered transient command image envelopes.
 */
export function encodeCommandImages(inputs: readonly SaveImageAttachment[]): readonly EncodedImageAttachment[] {
  return inputs.map(input => ({
    mediaType: input.mediaType,
    data: Buffer.from(input.data).toString('base64'),
    ...(input.name === undefined ? {} : { name: input.name }),
  }))
}
