import { describe, expect, test } from 'bun:test'
import {
  ARK_IMAGE_MODELS,
  ARK_IMAGE_PROVIDER,
  ARK_IMAGE_SIZES,
  DEFAULT_IMAGE_RESOLUTION,
  imageGenerationRequest,
  imageOptionsFromSettings,
  toolSchemaFor,
  resolveImageSettings,
} from '../src-tauri/resources/gui-extension'

/**
 * The image endpoint, as configured rather than as constant.
 *
 * Pi's provider config cannot describe an image model — its model schema has no
 * `type` discriminant — so `~/.pi/agent/image.json` names the endpoint, its
 * models and its size presets, and the extension merges them over the built-in
 * Ark defaults. Two things have to stay true for that to be safe: a config that
 * names nothing has to behave exactly as the constants did, and a config that
 * names something has to actually reach the request.
 */
const request = (stored: unknown, parts: Parameters<typeof imageGenerationRequest>[2], size?: unknown) =>
  imageGenerationRequest(resolveImageSettings(stored), 'model-a', parts, size)

describe('resolving the image settings', () => {
  test('an unconfigured install keeps the built-in Ark provider', () => {
    // Backward compatibility is the whole reason every key of the file is
    // optional: nothing changes until something is configured.
    const settings = resolveImageSettings(null)
    expect(settings.provider).toEqual(ARK_IMAGE_PROVIDER)
    expect(settings.models).toEqual(ARK_IMAGE_MODELS)
    expect(settings.sizes).toEqual(ARK_IMAGE_SIZES)
    expect(settings.defaults).toEqual({ resolution: DEFAULT_IMAGE_RESOLUTION })
  })

  test('a configured provider replaces the endpoint, and its trailing slash is dropped', () => {
    const settings = resolveImageSettings({
      provider: { id: 'my-endpoint', name: '我的出图', baseUrl: 'https://img.test/v1/' },
    })
    expect(settings.provider).toEqual({
      id: 'my-endpoint',
      name: '我的出图',
      baseUrl: 'https://img.test/v1',
    })
    // …and only what was named: the models are still the built-in list.
    expect(settings.models).toEqual(ARK_IMAGE_MODELS)
  })

  test('a provider id or url that cannot be used falls back rather than propagating', () => {
    // The id becomes a key in Pi's `auth.json` and the url is fetched, so a bad
    // one is refused here instead of producing a provider nothing can reach.
    expect(resolveImageSettings({ provider: { id: 'has space' } }).provider.id).toBe(ARK_IMAGE_PROVIDER.id)
    expect(resolveImageSettings({ provider: { id: 'ok', baseUrl: 'img.test' } }).provider.baseUrl).toBe(ARK_IMAGE_PROVIDER.baseUrl)
    expect(resolveImageSettings({ provider: { id: 'ok', baseUrl: 'ftp://x' } }).provider.baseUrl).toBe(ARK_IMAGE_PROVIDER.baseUrl)
  })

  test('a model list is taken as given, and a broken entry is dropped', () => {
    const settings = resolveImageSettings({
      models: [{ id: 'a', name: 'A' }, { id: '' }, { name: 'no id' }, { id: 'b' }],
    })
    expect(settings.models).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: undefined }])
  })

  test('an empty model list means the built-in one, like omitting the key', () => {
    expect(resolveImageSettings({ models: [] }).models).toEqual(ARK_IMAGE_MODELS)
  })

  test('a size table replaces the presets, and empty levels are dropped', () => {
    const settings = resolveImageSettings({
      sizes: { '1:1': {}, '2K': { '1:1': '2048x2048', '': '  ' }, '4K': { '3:4': '3520x4704' } },
    })
    expect(settings.sizes).toEqual({ '2K': { '1:1': '2048x2048' }, '4K': { '3:4': '3520x4704' } })
  })

  test('defaults are clamped to what actually exists', () => {
    const settings = resolveImageSettings({
      models: [{ id: 'a' }],
      sizes: { '2K': { '1:1': '2048x2048' } },
      defaults: { model: 'gone', resolution: '9K', aspect: '21:9' },
    })
    // A default that names something the list no longer has is dropped, because
    // the file is edited by hand as well as by a form and a stale default is a
    // smaller problem than a failure in the middle of a request.
    expect(settings.defaults.model).toBeUndefined()
    expect(settings.defaults.resolution).toBe('2K')
    expect(settings.defaults.aspect).toBeUndefined()
  })

  test('a valid default survives, including the aspect that names its resolution', () => {
    const settings = resolveImageSettings({
      sizes: { '2K': { '1:1': '2048x2048', '3:4': '1728x2304' } },
      defaults: { resolution: '2K', aspect: '3:4' },
    })
    expect(settings.defaults).toEqual({ resolution: '2K', aspect: '3:4' })
  })

  test('the flat keys this file held before it could name a provider still work', () => {
    const settings = resolveImageSettings({ model: 'doubao-seedream-4-5-251128', resolution: '4K', aspect: '16:9' })
    expect(settings.defaults).toEqual({
      model: 'doubao-seedream-4-5-251128',
      resolution: '4K',
      aspect: '16:9',
    })
  })

  test('nested defaults win over the flat keys they replaced', () => {
    const settings = resolveImageSettings({ model: 'doubao-seedream-4-5-251128', defaults: { model: 'doubao-seedream-4-0-20260415' } })
    expect(settings.defaults.model).toBe('doubao-seedream-4-0-20260415')
  })
})

describe('the request an OpenAI-images endpoint receives', () => {
  test('goes to the configured endpoint, not a constant', () => {
    const { url } = request({ provider: { id: 'x', baseUrl: 'https://img.test/v1' } }, [{ type: 'text', text: 'hi' }])
    expect(url).toBe('https://img.test/v1/images/generations')
  })

  test('carries the prompt, the size and the base64 response format', () => {
    const { body } = request(null, [{ type: 'text', text: ' a cat ' }], '1728x2304')
    expect(body).toEqual({
      model: 'model-a',
      prompt: 'a cat',
      response_format: 'b64_json',
      size: '1728x2304',
      watermark: false,
    })
  })

  test('falls back to the default resolution when no size was chosen', () => {
    expect(request(null, [{ type: 'text', text: 'hi' }]).body.size).toBe(DEFAULT_IMAGE_RESOLUTION)
  })

  test('joins several text parts and ignores everything else', () => {
    const { body } = request(null, [{ type: 'text', text: 'one' }, { type: 'image', data: 'AA' }, { type: 'text', text: 'two' }])
    expect(body.prompt).toBe('one\ntwo')
  })

  test('reference images ride along as lowercase data URLs', () => {
    // This is what makes image-to-image work instead of plain text-to-image, and
    // it is invisible until someone tries it against a new endpoint.
    const { body } = request(null, [
      { type: 'text', text: 'restyle' },
      { type: 'image', mimeType: 'image/jpeg', data: 'QUJD' },
    ])
    expect(body.image).toEqual(['data:image/jpeg;base64,QUJD'])
  })

  test('no references means no image field at all', () => {
    expect(request(null, [{ type: 'text', text: 'hi' }]).body.image).toBeUndefined()
  })
})

describe('what the settings page and the tool schema are offered', () => {
  test('options come from the same table the tool resolves against', () => {
    expect(imageOptionsFromSettings(resolveImageSettings(null))).toEqual({
      resolutions: Object.keys(ARK_IMAGE_SIZES),
      aspects: Object.keys(ARK_IMAGE_SIZES[DEFAULT_IMAGE_RESOLUTION]!),
    })
    expect(
      imageOptionsFromSettings(resolveImageSettings({ sizes: { '2K': { '1:1': '2048x2048' } } })),
    ).toEqual({ resolutions: ['2K'], aspects: ['1:1'] })
  })

  test('the tool schema cannot offer a resolution the endpoint has no preset for', () => {
    const schema = toolSchemaFor(resolveImageSettings({ sizes: { '2K': { '1:1': '2048x2048' } }, models: [{ id: 'only' }] }), 'image')
    expect(schema.properties.resolution.enum).toEqual(['2K'])
    expect(schema.properties.aspect.enum).toEqual(['1:1'])
    expect(schema.properties.model.description).toContain('only')
  })

  test('the tool describes whichever provider is configured', () => {
    // A description that names 火山方舟 while the endpoint is someone else's is
    // how a model ends up explaining the wrong thing to a user.
    const settings = resolveImageSettings({ provider: { id: 'x', name: '我的出图', baseUrl: 'https://img.test/v1' } })
    expect(settings.provider.name).toBe('我的出图')
  })
})
