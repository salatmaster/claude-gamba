import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

import {
  FREE_MULT,
  FREE_SPINS,
  PAIR_PAY,
  SCATTER,
  SYMBOLS,
  applySpin,
  burned,
  deposit,
  fresh,
  payout,
  rank,
  rollWeek,
  rtp,
  scatters,
  spin,
} from '../hooks/game'
import type { Save } from '../hooks/game'
import { WIDTH, big, bulbs, layout, reelWindow } from '../hooks/art'
import { SPRITES, cells, rows, scene } from '../hooks/pixels'
import { BOUNCE_MS, STRIP, faces, plan, where } from '../hooks/reels'
import { LOCALES, detect, fill, pick } from '../locales/index'
import type { Phrases } from '../locales/index'

const en = LOCALES.en!
const ru = LOCALES.ru!
const LISTS: (keyof Phrases)[] = [
  'spin',
  'miss',
  'small',
  'big',
  'broke',
  'dep',
  'agentStart',
  'agentDone',
  'streak',
  'limit',
  'first',
  'offer',
  'bonus',
  'bonusEnd',
]

// ---------------------------------------------------------------- the slot

test('payouts: a pair from the left pays 2, three of a kind pays by symbol, the rest nothing', async () => {
  expect(payout([4, 4, 3])).toBe(PAIR_PAY)
  expect(payout([4, 3, 4])).toBe(0)
  expect(payout([3, 4, 4])).toBe(0)
  expect(payout([0, 1, 2])).toBe(0)
  SYMBOLS.forEach((symbol, i) => expect(payout([i, i, i])).toBe(symbol.pay))
  // The scatter pays in free spins, never on the line, and counts anywhere on it.
  expect(payout([SCATTER, SCATTER, 0])).toBe(0)
  expect(scatters([SCATTER, 0, SCATTER])).toBe(2)
  expect(scatters([0, 0, 0])).toBe(0)
})

// A seeded generator, so the big sample is the same on every run.
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('the slot returns less than it takes: exactly, and over 300,000 spins', async () => {
  const exact = rtp()
  expect(exact).toBeGreaterThan(0.6)
  expect(exact).toBeLessThan(0.9)

  // Played through applySpin, so the free spins the sample wins are in it too.
  const rng = seeded(42)
  const s = { ...fresh(), chips: Number.MAX_SAFE_INTEGER }
  while (s.wagered < 300_000 || s.free > 0) applySpin(s, spin(rng))
  expect(s.won / s.wagered).toBeLessThan(1)
  expect(Math.abs(s.won / s.wagered - exact)).toBeLessThan(0.05)
})

test('the reels run down the strip, stop left to right, and rest on the result', async () => {
  // The strip holds each symbol as often as its weight: what scrolls past is honest.
  SYMBOLS.forEach((symbol, i) => expect(STRIP.filter(face => face === i)).toHaveLength(symbol.weight))

  const rng = seeded(7)
  for (let n = 0; n < 200; n++) {
    const result = spin(rng)
    const planned = plan(result, rng)
    expect(planned.rest.map(at => faces(at)[1])).toEqual(result)
    expect(planned.stops[0]!).toBeLessThan(planned.stops[1]!)
    expect(planned.stops[1]!).toBeLessThan(planned.stops[2]!)
    let before = where(planned, 0)
    for (let ms = 33; ms <= planned.stops[2]! + BOUNCE_MS; ms += 33) {
      const now = where(planned, ms)
      now.forEach((at, i) => {
        // Towards the rest, never back; past its stop a reel only springs about it.
        if (ms <= planned.stops[i]!) expect(at).toBeLessThan(before[i]!)
        else expect(Math.abs(at - planned.rest[i]!)).toBeLessThan(0.2)
      })
      before = now
    }
    expect(where(planned, planned.stops[2]! + BOUNCE_MS)).toEqual(planned.rest)
  }
  // Two alike on the left: the third reel keeps you waiting.
  expect(plan([4, 4, 3]).stops[2]!).toBeGreaterThan(plan([4, 3, 3]).stops[2]!)
})

// ------------------------------------------------------------------- chips

test('chips: tokens convert at the rate, the remainder carries over, the cap holds', async () => {
  const s = fresh()
  expect(deposit(s, 5000, 2000, 20)).toBe(2)
  expect(s.dust).toBe(1000)
  expect(deposit(s, 1000, 2000, 20)).toBe(1)
  expect(s.chips).toBe(3)
  expect(deposit(s, 100_000, 2000, 5)).toBe(5)
  expect(deposit(s, 100_000, 2000, 0)).toBe(0)
  expect(s.chips).toBe(8)
  expect(s.week.tokens).toBe(206_000)

  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 9999 }
  expect(burned(usage)).toBe(60)
})

test('a spin costs a chip, pays the win and keeps the records', async () => {
  const s = { ...fresh(), chips: 3 }
  expect(applySpin(s, [4, 3, 2])).toBe(0)
  expect(applySpin(s, [3, 4, 4])).toBe(0)
  expect(s.chips).toBe(1)
  expect(s.missStreak).toBe(2)
  expect(applySpin(s, [5, 5, 5])).toBe(6)
  expect(s).toMatchObject({ chips: 6, spins: 3, wagered: 3, won: 6, maxWin: 6, missStreak: 0, maxMissStreak: 2 })
  expect(s.week.spins).toBe(3)

  // A bigger stake: the same payout, times it.
  const high = { ...fresh(), chips: 30, bet: 10 }
  expect(applySpin(high, [5, 5, 5])).toBe(60)
  expect(high).toMatchObject({ chips: 80, wagered: 10, won: 60, maxWin: 60 })
  expect(applySpin(high, [4, 4, 0])).toBe(20)
  // Fewer chips than the stake: the spin goes all in with what there is.
  const low = { ...fresh(), chips: 7, bet: 25 }
  expect(applySpin(low, [0, 1, 2])).toBe(0)
  expect(low).toMatchObject({ chips: 0, wagered: 7 })
})

test('scatters on a paid spin grant free spins: no stake, the payout times the stake that won them', async () => {
  const s = { ...fresh(), chips: 10, bet: 5 }
  expect(applySpin(s, [SCATTER, 0, SCATTER])).toBe(0)
  expect(s).toMatchObject({ chips: 5, free: FREE_SPINS[2], freeBet: 5, wagered: 5 })
  s.bet = 25 // the stake of the free spins is already fixed
  expect(applySpin(s, [5, 5, 5])).toBe(6 * 5 * FREE_MULT)
  expect(applySpin(s, [SCATTER, SCATTER, SCATTER])).toBe(0) // no retrigger
  expect(s).toMatchObject({ chips: 65, free: FREE_SPINS[2]! - 2, freeWon: 60, wagered: 5, won: 60, spins: 3 })
  while (s.free > 0) applySpin(s, [0, 1, 2])
  expect(s).toMatchObject({ chips: 65, wagered: 5 })
  // Spent: the next spin costs again.
  applySpin(s, [0, 1, 2])
  expect(s).toMatchObject({ chips: 40, wagered: 30, free: 0 })

  // Three scatters grant more; going all in, the free spins keep the smaller stake.
  const low = { ...fresh(), chips: 2, bet: 10 }
  applySpin(low, [SCATTER, SCATTER, SCATTER])
  expect(low).toMatchObject({ chips: 0, free: FREE_SPINS[3], freeBet: 2 })
})

test('ranks climb with all-time spins, and the week turns over on Monday', async () => {
  expect([0, 9, 10, 99, 100, 500, 2000, 99_999].map(rank)).toEqual([0, 0, 1, 1, 2, 3, 4, 4])

  const s = fresh()
  rollWeek(s, Date.UTC(2026, 8, 29)) // a Tuesday
  s.week.spins = 7
  rollWeek(s, Date.UTC(2026, 9, 4, 23, 59)) // Sunday night, same week
  expect(s.week.spins).toBe(7)
  rollWeek(s, Date.UTC(2026, 9, 5)) // Monday
  expect(s.week.spins).toBe(0)
})

// ----------------------------------------------------------------- phrases

test('a phrase never comes up twice in a row', async () => {
  for (const [code, locale] of Object.entries(LOCALES)) {
    for (const list of LISTS) {
      let previous = ''
      for (let i = 0; i < 300; i++) {
        const phrase = pick(locale[list], `${code}.${list}`)
        expect(phrase, `${code}.${list}`).not.toBe(previous)
        previous = phrase
      }
    }
  }
})

test('every language has every list, short phrases, and nothing it must not have', async () => {
  const vars = { chips: 20, tokens: 123_456, n: 23, pct: 80 }
  for (const [code, locale] of Object.entries(LOCALES)) {
    for (const list of LISTS) {
      expect(locale[list].length, `${code}.${list}`).toBeGreaterThan(1)
      for (const phrase of locale[list]) {
        const shown = fill(locale, phrase, vars)
        expect([...shown].length, `${code}.${list}: ${shown}`).toBeLessThanOrEqual(60)
        expect(shown, 'an unfilled placeholder').not.toMatch(/[{}]|undefined/)
        expect(shown, 'no names, no links').not.toMatch(/мел+стро|mel+stroy|https?:|www\./i)
      }
    }
    expect(locale.ranks).toHaveLength(5)
    // The sign is drawn in the big font: every letter of it has to be there.
    for (const letter of locale.title) expect(big(letter)[0], `${code} title: ${letter}`).not.toBe('')
  }
})

test('numbers are grouped and take the right plural form', async () => {
  const chips = '{chips:фантик|фантика|фантиков}'
  expect([1, 3, 5, 11, 21, 112].map(n => fill(ru, chips, { chips: n }))).toEqual([
    '1 фантик',
    '3 фантика',
    '5 фантиков',
    '11 фантиков',
    '21 фантик',
    '112 фантиков',
  ])
  expect(fill(ru, '{tokens}', { tokens: 1_234_567 })).toBe('1 234 567')
  expect(fill(en, '{tokens:token|tokens}', { tokens: 1_234_567 })).toBe('1,234,567 tokens')
  expect(fill(en, '+{chips:chip|chips}', { chips: 1 })).toBe('+1 chip')
})

test('language: Cyrillic in a prompt means Russian, anything else decides nothing', async () => {
  expect(detect('почини тесты')).toBe('ru')
  expect(detect('why does тест fail')).toBe('ru')
  expect(detect('fix the tests')).toBeUndefined()
  expect(detect('да')).toBeUndefined()
})

// ------------------------------------------------------- the mod, end to end

const NOW = Date.UTC(2026, 9, 6, 12)

const PANE = {
  plugin: 'gamba',
  component: 'Pane',
  requestId: 'gamba',
  viewport: { columns: 120, rows: 40 },
  props: {
    title: 'gamba',
    isFocused: true,
    bodyColumns: 40, // too narrow for big digits: the balance is a line of text
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'gamba',
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: true, maxRows: 5, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} },
} as const

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

function thisWeek(stats: { waitedMs: number; spins: number; tokens: number }): Save['week'] {
  const s = fresh()
  rollWeek(s, NOW)
  return { ...stats, id: s.week.id }
}

// Stands in for Claude Code: a store in memory, a clock the test moves, and
// a record of every toast, copy and pane the mod asked for.
function stubs(on: On, initial?: Partial<Save>, usage: TurnUsage | null = null) {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>(initial ? [['save', { ...fresh(), ...initial }]] : [])
  const seen = {
    blits: 0, // the cabinet repainted in place
    toasts: [] as string[],
    copies: [] as string[],
    sounds: [] as string[],
    opens: 0,
    focused: 0,
    isUp: false, // the pane is on screen
    seatsUnasked: true, // the terminal is wide enough for a pane nobody asked for
  }
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.open', ($, e) => {
    seen.opens += 1
    if (e.focus) seen.focused += 1
    seen.isUp = e.focus === true || seen.seatsUnasked
    return { value: seen.isUp ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.close', () => {
    seen.isUp = false
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: seen.isUp ? [{ id: 'gamba', title: 'gamba', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  // What Claude Code itself draws above the prompt, beneath the mod's offer.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['beneath'] }))
  on('ui.blit', () => {
    seen.blits += 1
    return { value: {} }
  })
  on('audio.play', ($, e) => {
    seen.sounds.push(e.clip.asset ?? '')
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    seen.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage }
  })
  return { clock, seen, saved: () => store.get('save') as Save }
}

// One model request of a turn, read to its end as the engine reads it.
// A subagent's run is a turn of its own, under its own id.
async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: agentId ?? 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) })
  let chunk = await stream.next()
  while (chunk.done !== true) chunk = await stream.next()
  return chunk.value
}

// `/gamba <args>` as the person typing it at the prompt.
const gamba = ($: Engine, args = '', command = 'gamba') =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

const complete = (durationMs: number) =>
  ({ turnId: 't', answer: 'ok', durationMs, isAborted: false, reason: 'answer' }) as const

const BURN: TurnUsage = {
  model: 'claude-test',
  input_tokens: 500,
  output_tokens: 1500,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: 50_000, // re-read context: not counted
}

test(
  'an agent turn deposits chips for the tokens it burned, up to the cap, and the wait is counted',
  async ($, on) => {
    const { clock, saved } = stubs(on, { rate: 1000, cap: 5 }, BURN)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const says = async (phrases: string[]) => {
      const drawn = (await ui.findAll({ type: 'Text' })).map(text => text.text)
      return phrases.some(phrase => drawn.includes(phrase))
    }

    await $.turn.start({ turnId: 't', text: 'go' })
    expect(await says(en.agentStart)).toBe(true)
    expect((await step($)).answer).toBe('ok')
    expect(saved().chips).toBe(3)
    await step($)
    expect(saved().chips).toBe(5) // the cap holds for the turn
    await step($, 'subagent-1') // a subagent's run is a turn with a cap of its own
    expect(saved().chips).toBe(8)
    await $.turn.complete({ ...complete(90_000), turnId: 'subagent-1', agentId: 'subagent-1' })
    expect(saved().week.waitedMs).toBe(0)
    await $.turn.complete(complete(90_000))
    expect(saved().week).toMatchObject({ tokens: 9000, waitedMs: 90_000 })
    // The agent line reports the deposit, then nudges back to work.
    expect(await says(en.dep.map(phrase => fill(en, phrase, { chips: 8, tokens: 9000 })))).toBe(true)
    expect(await says(en.agentDone)).toBe(false)
    await clock.advance(5000)
    expect(await says(en.agentDone)).toBe(true)

    // A background workflow's agents step on after the turn that started
    // them ended, each one up to its own cap.
    await step($, 'workflow-1')
    await step($, 'workflow-2')
    expect(saved().chips).toBe(14)

    await $.turn.start({ turnId: 't', text: 'again' }) // a new turn, a new cap
    await step($)
    expect(saved().chips).toBe(17)
  },
)

test('while the agent works the slot is offered above the prompt: yes, no, always, never', async ($, on) => {
  const { seen, saved } = stubs(on, undefined, BURN)
  const turn = () => $.turn.start({ turnId: 't', text: 'go' })
  const done = () => $.turn.complete(complete(1000))
  await $.session.start(START)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const isAsking = async () => (await band.find({ key: 'offer-yes' })) !== undefined

  expect(await isAsking()).toBe(false) // nobody is waiting for anything yet
  await turn()
  expect(await isAsking()).toBe(true)
  const question = (await band.find({ type: 'Text', text: /^🎰 / }))!.text.slice(3)
  expect(en.offer).toContain(question)
  expect(await band.find({ type: 'Text', text: 'beneath' })).toBeDefined() // the band's other tenants stay
  expect(seen.opens).toBe(0) // asking is all it does: the pane stays shut

  await band.press({ key: 'offer-no' }) // no: not this turn
  expect(await isAsking()).toBe(false)
  await done()
  await turn()
  expect(await isAsking()).toBe(true) // but the next one asks again
  await done()
  expect(await isAsking()).toBe(false) // the agent is back: nothing to wait for

  await turn()
  await band.press({ key: 'offer-yes' }) // yes: open now, with the keyboard
  expect(seen).toMatchObject({ opens: 1, focused: 1 })
  expect(await isAsking()).toBe(false)
  await turn()
  expect(await isAsking()).toBe(false) // already on screen: nothing to offer
  seen.isUp = false

  await turn()
  await band.press({ key: 'offer-always' }) // always: open now and from here on
  expect(saved().offer).toBe('always')
  expect(seen).toMatchObject({ opens: 2, focused: 2 })
  seen.isUp = false
  await turn()
  expect(seen).toMatchObject({ opens: 3, focused: 2 }) // opened unasked, the keyboard left alone
  expect(await isAsking()).toBe(false)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'close' }) // closing the pane does not take "always" back
  expect(saved().offer).toBe('always')
  await turn()
  expect(seen).toMatchObject({ opens: 4, focused: 2 })

  seen.isUp = false
  seen.seatsUnasked = false // a narrow terminal seats no pane nobody asked for
  await turn()
  expect(await isAsking()).toBe(true) // so it asks, but only whether to open now
  expect(await band.find({ key: 'offer-always' })).toBeUndefined()
  await band.press({ key: 'offer-no' })

  await pane.press({ key: 'offer' }) // the pane's button: always -> never
  expect(saved().offer).toBe('never')
  await done()
  await turn()
  expect(await isAsking()).toBe(false) // never: only /gamba from now on
  expect(seen.opens).toBe(5)
  await pane.press({ key: 'offer' }) // and back to asking
  expect(saved().offer).toBe('ask')
  await done()
  await turn()
  await band.press({ key: 'offer-never' })
  expect(saved().offer).toBe('never')
})

test('the stake: 2 and 3 step through the stakes, a click picks one, the win scales with it', async ($, on) => {
  const { clock, saved } = stubs(on, { chips: 1000, seen: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const chip = async () => (await ui.find({ type: 'Text', text: /^ \d+ $/ }))?.text // the chosen stake's gold chip

  expect(await chip()).toBe(' 1 ')
  await ui.press({ key: 'bet-down' }) // already the lowest
  expect(saved()?.bet ?? 1).toBe(1)
  for (let i = 0; i < 4; i++) await ui.press({ key: 'bet-up' })
  expect(saved().bet).toBe(10)
  expect(await chip()).toBe(' 10 ')
  expect(await ui.find({ key: 'bet-10' })).toBeUndefined() // nothing to pick: it is the one
  await ui.press({ key: 'bet-25' })
  await ui.press({ key: 'bet-up' }) // already the highest
  expect(saved().bet).toBe(25)
  await ui.press({ key: 'bet-down' })
  expect(saved().bet).toBe(20)

  await ui.press({ key: 'spin' })
  await clock.advance(5000)
  const after = saved()
  expect(after.wagered).toBe(20)
  expect(after.chips).toBe(1000 - 20 + after.won)
  expect(after.won % 20).toBe(0)
})

test('the first launch says so, once', async ($, on) => {
  const { saved } = stubs(on)
  await $.session.start(START)
  await gamba($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const said = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(en.first.some(phrase => said.includes(phrase))).toBe(true)
  expect(saved().seen).toBe(true)
})

test(
  'a spin takes the bet at once, holds the win until the reels stop, then pays',
  { timeoutMs: 30_000 },
  async ($, on) => {
    const { clock, saved, seen: heard } = stubs(on, { chips: 500, seen: true })
    await $.session.start(START)
    const pays = [0, PAIR_PAY, ...SYMBOLS.map(symbol => symbol.pay)]
    let balance = 500
    let spins = 0
    let wins = 0
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      // The reels are random, so spin until this surface has shown both a
      // win and a miss; 200 spins without one of them does not happen.
      const seen = new Set<boolean>()
      // The records next to the reels: the return so far and the week's spins.
      const records = async () =>
        (await ui.findAll({ type: 'Text' })).map(text => text.text).filter(text => /^(\d+%|—|\d+)$/.test(text))
      for (let i = 0; i < 200 && seen.size < 2; i++) {
        // Scatters may have won free spins: those stake nothing and pay double.
        const before = saved()
        const stake = before.free > 0 ? 0 : 1
        const times = before.free > 0 ? before.freeBet * FREE_MULT : 1
        const shown = await records()
        await ui.press({ key: 'spin' })
        await ui.press({ key: 'spin' }) // a second press mid-spin is ignored
        const after = saved()
        const win = after.chips - (balance - stake)
        expect(after.spins).toBe((spins += 1))
        expect(pays.map(pay => pay * times)).toContain(win)
        // Saved already, but the pane shows the balance without the win.
        expect(await ui.find({ type: 'Text', text: `Balance: ${balance - stake}` })).toBeDefined()
        expect(await records()).toEqual(shown) // nor do the records give the result away
        await clock.advance(5000) // the reels stop and the win is counted up
        expect(await ui.find({ type: 'Text', text: `Balance: ${after.chips}` })).toBeDefined()
        expect(await records()).not.toEqual(shown) // the spin counter moved at least
        expect((await ui.findAll({ type: 'Text', text: /^(► |  )║(   \S+   ║){3}( ◄|  )$/u }))).toHaveLength(3)
        balance = after.chips
        wins += win
        seen.add(win > 0)
      }
      expect(seen.size).toBe(2)
      await ui.unmount()
    }
    expect(saved().won).toBe(wins)
    expect(balance).toBe(500 - saved().wagered + wins)
    // Every reel clacks as it stops, and a win has its own sound.
    expect(heard.sounds.filter(sound => sound === 'sounds/stop.wav')).toHaveLength(spins * 3)
    expect(heard.sounds.some(sound => sound === 'sounds/win.wav' || sound === 'sounds/big.wav')).toBe(true)
  },
)

test('free spins spin with no chips, count down in place of the stake, and sum up at the end', async ($, on) => {
  const { clock, saved } = stubs(on, { chips: 0, seen: true, free: 2, freeBet: 5 })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Free spins: 2 · Bet 5 ×2' })).toBeDefined()
  expect(await ui.find({ key: 'bet-up' })).toBeUndefined()
  await ui.press({ key: 'spin' })
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: 'Free spins: 1 · Bet 5 ×2' })).toBeDefined()
  await ui.press({ key: 'spin' })
  await clock.advance(5000)
  const after = saved()
  expect(after).toMatchObject({ spins: 2, wagered: 0, free: 0, chips: after.freeWon })
  const said = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(en.bonusEnd.some(phrase => said.includes(fill(en, phrase, { n: after.freeWon })))).toBe(true)
  expect(await ui.find({ key: 'bet-up' })).toBeDefined() // the stake is back
})

test('no chips, no spin', async ($, on) => {
  const { clock, saved } = stubs(on, { chips: 0, seen: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'spin' })
  await clock.advance(5000)
  expect(saved()?.spins ?? 0).toBe(0)
  const said = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  expect(en.broke.some(phrase => said.includes(phrase))).toBe(true)
})

test('the pane picks its layout from the room it has', async () => {
  const parts = (placement: 'dock' | 'inline', columns: number, rows: number) => {
    const view = layout(placement, columns, rows)
    return [
      view.isWide ? 'wide' : 'narrow',
      `bank ${view.bank}`,
      `stats ${view.stats}`,
      ...(view.hasLights ? ['lights'] : []),
      ...(view.hasTitle ? ['title'] : []),
      ...(view.hasPays ? ['pays'] : []),
    ].join(', ')
  }
  // The sidebar loses parts one at a time as it gets shorter.
  expect(parts('dock', 66, 50)).toBe('wide, bank below, stats card, lights, title, pays')
  expect(parts('dock', 66, 36)).toBe('wide, bank below, stats card, lights, title')
  expect(parts('dock', 66, 30)).toBe('wide, bank below, stats card, lights')
  expect(parts('dock', 66, 26)).toBe('wide, bank below, stats card, lights')
  expect(parts('dock', 66, 23)).toBe('wide, bank beside, stats card, lights')
  expect(parts('dock', 66, 19)).toBe('wide, bank beside, stats lines, lights')
  expect(parts('dock', 48, 19)).toBe('wide, bank below, stats lines, lights')
  expect(parts('dock', 48, 10)).toBe('wide, bank line, stats lines')
  expect(layout('dock', 66, 32).gap).toBe(1)
  expect(layout('dock', 66, 27).gap).toBe(0)
  // Above the prompt it spreads sideways.
  expect(parts('inline', 100, 12)).toBe('wide, bank beside, stats split')
  expect(parts('inline', 76, 12)).toBe('wide, bank beside, stats split')
  expect(parts('inline', 70, 12)).toBe('wide, bank beside, stats lines')
  expect(parts('inline', 40, 12)).toBe('wide, bank line, stats lines')
  expect(parts('inline', 30, 12)).toBe('narrow, bank line, stats lines')

  expect(big('17')).toEqual(['▄█  ▀▀█', ' █    █', '▀▀▀   ▀'])
  expect(bulbs(9, 0)).toBe('● ○ ○ ● ○')
  expect(bulbs(9, 1)).toBe('○ ○ ● ○ ○')
  for (const isWide of [false, true]) {
    const lines = reelWindow([0, 7, 13], isWide)
    expect(lines).toHaveLength(5)
    // One width, an emoji counting for two cells: the window centers as a block.
    const cells = (line: string) => [...line].reduce((n, char) => n + (SYMBOLS.some(s => s.emoji === char) ? 2 : 1), 0)
    expect(new Set(lines.map(cells)).size).toBe(1)
  }
})

test('where pixels are drawn and fit, the cabinet is: sign, reels and balance, then less of it', async () => {
  const parts = (placement: 'dock' | 'inline', columns: number, height: number) => {
    const view = layout(placement, columns, height, true)
    if (view.cabinet === undefined) return 'text'
    return [
      `${rows(view.cabinet)} rows`,
      ...(view.cabinet.hasSign ? ['sign'] : []),
      `bank ${view.bank}`,
      `stats ${view.stats}`,
      ...(view.hasPays ? ['pays'] : []),
      ...(view.gap ? ['gaps'] : []),
    ].join(', ')
  }
  expect(parts('dock', 66, 64)).toBe('35 rows, sign, bank drawn, stats card, pays, gaps')
  expect(parts('dock', 66, 57)).toBe('35 rows, sign, bank drawn, stats card, gaps')
  expect(parts('dock', 66, 49)).toBe('35 rows, sign, bank drawn, stats lines, gaps')
  expect(parts('dock', 66, 44)).toBe('35 rows, sign, bank drawn, stats lines')
  expect(parts('dock', 66, 40)).toBe('26 rows, bank drawn, stats lines, gaps')
  expect(parts('dock', 66, 35)).toBe('26 rows, bank drawn, stats lines')
  expect(parts('dock', 66, 26)).toBe('12 rows, bank line, stats lines, gaps')
  expect(parts('dock', 66, 20)).toBe('12 rows, bank line, stats lines')
  expect(parts('dock', 66, 17)).toBe('12 rows, bank line, stats none')
  expect(parts('dock', 66, 16)).toBe('text')
  expect(parts('dock', 55, 50)).toBe('text') // the cabinet is 56 cells wide
  // Above the prompt: the reels, the rest in a column beside them.
  expect(parts('inline', 104, 12)).toBe('12 rows, bank beside, stats lines')
  expect(layout('inline', 104, 12, true).isAside).toBe(true)
  // Narrower, the words go under the reels: only in a terminal tall enough for both.
  expect(parts('inline', 103, 36)).toBe('12 rows, bank line, stats lines')
  expect(layout('inline', 103, 36, true).isAside).toBeUndefined()
  expect(parts('inline', 56, 36)).toBe('12 rows, bank line, stats lines')
  expect(parts('inline', 103, 35)).toBe('text')
  expect(parts('inline', 55, 60)).toBe('text')

  // One sprite a symbol, sixteen pixels square.
  expect(SPRITES).toHaveLength(SYMBOLS.length)
  for (const sprite of SPRITES) expect(sprite.map(line => line.length)).toEqual(Array(16).fill(16))

  const full = { hasSign: true, hasBank: true, sliver: 7 }
  const look = { title: 'GAMBA', at: [14, 6.4, 20], phase: 0, frame: 0, glow: 0, isLit: false, hits: [false, false, false], balance: 207, isPaying: false }
  const canvas = scene(full, look)
  expect([canvas.w, canvas.h]).toEqual([WIDTH, rows(full) * 2])
  // Twelve bytes a cell, as base64; every cell a space or a half block.
  const bytes = Uint8Array.from(atob(cells(canvas)), char => char.charCodeAt(0))
  expect(bytes).toHaveLength(WIDTH * rows(full) * 12)
  const words = new Uint32Array(bytes.buffer)
  expect(new Set(words.filter((_, i) => i % 3 === 0))).toEqual(new Set([0x20, 0x2580, 0x2584]))
  // A long balance, a big win and reels in motion all stay on the canvas.
  expect(cells(scene(full, { ...look, balance: 123_456_789, glow: 2, isLit: true, frame: 99 }))).toHaveLength(bytes.length * 4 / 3)
})

test('every layout draws on every surface: pixels on the terminal where they fit, text elsewhere', async ($, on) => {
  const { clock, seen } = stubs(on, { chips: 35, seen: true, spins: 121 })
  await $.session.start(START)
  const rooms = [
    ['dock', 66, 62],
    ['dock', 66, 50],
    ['dock', 66, 36],
    ['dock', 66, 30],
    ['dock', 66, 26],
    ['dock', 66, 23],
    ['dock', 66, 19],
    ['dock', 48, 19],
    ['dock', 48, 10],
    ['inline', 120, 12],
    ['inline', 76, 12],
    ['inline', 70, 12],
    ['inline', 40, 12],
    ['inline', 30, 12],
  ] as const
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [placement, bodyColumns, bodyRows] of rooms) {
      // Above the prompt the layout goes by the terminal's height, not the pane's.
      const height = placement === 'dock' ? bodyRows : PANE.viewport.rows
      const view = layout(placement, bodyColumns, height, surface === 'terminal')
      const room = `${surface} ${placement} ${bodyColumns}x${bodyRows}`
      const ui = await $.ui.mount({
        ...PANE,
        surface,
        props: { ...PANE.props, placement, bodyColumns, scroll: { offset: 0, bodyRows } },
      })
      const has = async (text: string | RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
      expect(await has(big('35')[0]), room).toBe(view.bank === 'below' || view.bank === 'beside')
      expect(await has('Balance: 35'), room).toBe(view.bank === 'line')
      expect(await has(big('GAMBA')[0]), room).toBe(view.hasTitle)
      const cabinet = await ui.find({ type: 'Raster' })
      expect(cabinet !== undefined, room).toBe(view.cabinet !== undefined)
      expect(await has(view.isWide ? /^► ║(   \S+   ║){3} ◄$/u : /^>│(  \S+  │){3}<$/u), room).toBe(cabinet === undefined)
      expect(await has('Redepositor'), room).toBe(view.stats !== 'none')
      expect(await ui.find({ key: 'spin' }), room).toBeDefined()
      await ui.unmount()
    }
  }
  // While the reels run the cabinet is repainted in place; text is drawn again.
  for (const [surface, placement, isPainted] of [
    ['terminal', 'dock', true],
    ['terminal', 'inline', false], // PANE is 40 columns: too narrow for the cabinet
    ['desktop', 'dock', false],
  ] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, placement, scroll: { offset: 0, bodyRows: 50 }, bodyColumns: placement === 'dock' ? 66 : 40 } })
    seen.blits = 0
    await ui.press({ key: 'spin' })
    await clock.advance(5000)
    expect(seen.blits > 0, `${surface} ${placement}`).toBe(isPainted)
    await ui.unmount()
  }
})

test('the sound button mutes the slot', async ($, on) => {
  const { clock, saved, seen } = stubs(on, { chips: 3, seen: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sound' })
  expect(saved().sound).toBe(false)
  await ui.press({ key: 'spin' })
  await clock.advance(5000)
  expect(saved().spins).toBe(1)
  expect(seen.sounds).toEqual([])
})

test('language: follows the prompts until the button overrides it', async ($, on) => {
  const { saved } = stubs(on, { chips: 1, seen: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const spinLabel = async () => (await ui.find({ key: 'spin' }))?.text

  expect(await spinLabel()).toBe('Spin')
  await $.prompt.submit({ text: 'fix the flaky test', wait: false, origin: { kind: 'composer' } })
  expect(await spinLabel()).toBe('Spin')
  await $.prompt.submit({ text: 'почини тесты, пожалуйста', wait: false, origin: { kind: 'composer' } })
  expect(await spinLabel()).toBe('Крутить')
  await $.prompt.submit({ text: 'thanks', wait: false, origin: { kind: 'composer' } })
  expect(await spinLabel()).toBe('Крутить') // one English prompt does not flip it back

  await ui.press({ key: 'lang' }) // auto -> en
  expect(await spinLabel()).toBe('Spin')
  await ui.press({ key: 'lang' }) // en -> ru
  expect(await spinLabel()).toBe('Крутить')
  expect(saved().lang).toBe('ru')
})

test('stats outlive the session, and the copy button puts one line on the clipboard', async ($, on) => {
  const week = thisWeek({ waitedMs: 3.5 * 3_600_000, spins: 121, tokens: 1_234_567 })
  const { seen } = stubs(on, { seen: true, chips: 4, spins: 121, detected: 'ru', week, rest: [14, 14, 14] })
  const line = 'За неделю: прождал агента 3,5 ч, сделал 121 спин, депнул 1 234 567 токенов. Ранг: Додепщик'

  await $.session.start(START) // a new session: nothing in memory, only the store
  expect((await gamba($, 'stats')).text).toBe(line)
  expect((await gamba($, 'stats', 'ludka')).text).toBe(line) // the Russian alias is the same command

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Баланс: 4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '► ║   🚀   ║   🚀   ║   🚀   ║ ◄' })).toBeDefined() // the reels as they stopped
  await ui.press({ key: 'copy' })
  expect(seen.copies).toEqual([line])
  expect(await ui.find({ type: 'Text', text: ru.labels.copied })).toBeDefined()
})

test('the settings are /gamba rate, cap and warn; nothing asks for them at install', async ($, on) => {
  const { saved } = stubs(on, { seen: true })
  await $.session.start(START)
  expect((await gamba($, 'config')).text).toBe(
    'Tokens per chip: 2,000 · Chips per turn, at most: 20 · Limit warning: 80%\n/gamba rate N · /gamba cap N · /gamba warn N',
  )
  expect((await gamba($, 'rate 500')).text).toMatch('Tokens per chip: 500 ·')
  await gamba($, 'cap 50', 'ludka')
  await gamba($, 'warn 90')
  expect(saved()).toMatchObject({ rate: 500, cap: 50, warn: 90 })
  // Out of bounds or not a number: nothing changes, the settings are listed again.
  for (const bad of ['warn 0', 'warn 101', 'rate', 'rate lots', 'cap 2.5']) await gamba($, bad)
  expect(saved()).toMatchObject({ rate: 500, cap: 50, warn: 90 })
})

test(
  'the weekly limit warns past the threshold, once per window',
  async ($, on) => {
    const { clock, seen } = stubs(on)
    await $.session.start(START)
    const measure = (kind: string, percentUsed: number, resetsAt: string) =>
      $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind, percentUsed, resetsAt }], changed: ['rateLimits'] })
    const resets = new Date(NOW + 3 * 86_400_000).toISOString()

    await measure('seven_day', 79.9, resets)
    await measure('five_hour', 99, resets)
    expect(seen.toasts).toEqual([])

    await measure('seven_day', 80.5, resets)
    expect(seen.toasts).toHaveLength(1)
    expect(en.limit.map(phrase => fill(en, phrase, { pct: 80 }))).toContain(seen.toasts[0])

    await measure('seven_day', 91, resets)
    expect(seen.toasts).toHaveLength(1)

    await clock.advance(4 * 86_400_000) // the window reset; it fills up again
    await measure('seven_day', 85, new Date(NOW + 10 * 86_400_000).toISOString())
    expect(seen.toasts).toHaveLength(2)
  },
)
