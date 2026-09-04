import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { ImageDrafts, admitImageDrafts, imageMediaType, imagePath } from '../src/image-drafts.ts'

describe('image draft paths', () => {
  it('keeps the command remainder as one path and accepts the completion sigil', () => {
    expect(imagePath(' @screens/界 面.png ')).toBe('screens/界 面.png')
    expect(imagePath(' "screens/a b.png" ')).toBe('screens/a b.png')
    expect(imagePath(" 'screens/a b.png' ")).toBe('screens/a b.png')
  })

  it('does not interpret backslashes or unmatched quotes as shell syntax', () => {
    expect(imagePath(String.raw`C:\shots\a.png`)).toBe(String.raw`C:\shots\a.png`)
    expect(imagePath('"unfinished.png')).toBe('"unfinished.png')
  })

  it('recognizes only Harness image media types, case-insensitively', () => {
    expect(imageMediaType('a.PNG')).toBe('image/png')
    expect(imageMediaType('a.jpeg')).toBe('image/jpeg')
    expect(imageMediaType('a.svg')).toBeUndefined()
    expect(imageMediaType('a.ts')).toBeUndefined()
  })
})

describe('session image drafts', () => {
  it('stages paths without reading them and rejects exact duplicates', () => {
    const drafts = new ImageDrafts()
    expect(drafts.stage('@画 面.webp')).toMatchObject({ ok: true, draft: { name: '画 面.webp' } })
    expect(drafts.stage('@画 面.webp')).toEqual({ ok: false, reason: 'duplicate' })
    expect(drafts.stage('notes.txt')).toEqual({ ok: false, reason: 'unsupported-type' })
    expect(drafts.size).toBe(1)
    drafts.clear()
    expect(drafts.items).toEqual([])
  })

  it('applies authoritative count and media-type limits before staging', () => {
    const drafts = new ImageDrafts()
    const policy = { maxImages: 1, mediaTypes: ['image/png'] as const }
    expect(drafts.stage('one.webp', policy)).toEqual({ ok: false, reason: 'deployment-type' })
    expect(drafts.stage('one.png', policy).ok).toBe(true)
    expect(drafts.stage('two.png', policy)).toEqual({ ok: false, reason: 'too-many' })
  })

  it('removes only a valid one-based position', () => {
    const drafts = new ImageDrafts()
    drafts.stage('one.png')
    drafts.stage('two.png')
    expect(drafts.remove(0)).toBeUndefined()
    expect(drafts.remove(2)?.name).toBe('two.png')
    expect(drafts.items.map(item => item.name)).toEqual(['one.png'])
  })
})

describe('Harness image admission', () => {
  it('bounds filesystem reads, preserves order, and exposes only basenames to durable storage', async () => {
    const drafts = new ImageDrafts()
    drafts.stage('/secret/folder/一.png')
    drafts.stage('two.jpg')
    const resolve = vi.fn(async (path: string) => ({ targetKey: path, displayPath: path }))
    const readBytes = vi.fn(async (target: { targetKey: string }) => Uint8Array.of(target.targetKey.length))
    const saveImages = vi.fn(async (inputs: readonly { mediaType: string; name?: string }[]) => inputs.map((input, index) => ({
      attachmentId: `opaque-${String(index)}`,
      mediaType: input.mediaType,
      bytes: 1,
      width: 1,
      height: 1,
      name: input.name,
    }) as ImageAttachmentRef))
    const fs = { resolve, readBytes } as unknown as FileSystem
    const attachments = {
      imageLimits: { maxImageBytes: 123, maxImagesPerMessage: 20, maxMessageImageBytes: 200, maxImagePixels: 10, maxImageDimension: 10, mediaTypes: ['image/png', 'image/jpeg'] },
      saveImages,
    } as unknown as AttachmentStore

    const blocks = await admitImageDrafts(drafts.items, fs, attachments, '/workspace')

    expect(resolve.mock.calls).toEqual([
      ['/secret/folder/一.png', { cwd: '/workspace' }],
      ['two.jpg', { cwd: '/workspace' }],
    ])
    expect(readBytes.mock.calls.map(call => [call[0].targetKey, call[2]])).toEqual([
      ['/secret/folder/一.png', 123],
      ['two.jpg', 123],
    ])
    expect(saveImages.mock.calls[0]?.[0].map(input => input.name)).toEqual(['一.png', 'two.jpg'])
    expect(blocks.map(block => block.attachment.attachmentId)).toEqual(['opaque-0', 'opaque-1'])
  })

  it('does not call durable storage when a bounded read fails', async () => {
    const drafts = new ImageDrafts()
    drafts.stage('gone.png')
    const refused = new Error('file disappeared')
    const fs = {
      resolve: async () => ({ targetKey: 'gone', displayPath: 'gone.png' }),
      readBytes: async () => { throw refused },
    } as unknown as FileSystem
    const saveImages = vi.fn()
    const attachments = {
      imageLimits: { maxImageBytes: 1 },
      saveImages,
    } as unknown as AttachmentStore

    await expect(admitImageDrafts(drafts.items, fs, attachments, '.')).rejects.toBe(refused)
    expect(saveImages).not.toHaveBeenCalled()
  })
})
