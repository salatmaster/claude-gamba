import type { EngineInterface, Register, Timer } from 'claude-code'

import { FALLBACK, LOCALES, detect, fill, pick } from '../locales/index'
import type { Locale, Phrases } from '../locales/index'
import {
  BETS,
  FREE_MULT,
  FREE_SPINS,
  OFFERS,
  PAIR_PAY,
  SCATTER,
  SYMBOLS,
  WEEK_MS,
  applySpin,
  burned,
  deposit,
  fresh,
  payout,
  rank,
  rollWeek,
  spin,
} from './game'
import type { Offer, Reels, Save } from './game'
import { BOUNCE_MS, FRAME_MS, plan, where } from './reels'
import { WIDTH, big, bulbs, layout, reelWindow } from './art'
import type { Parts } from './art'
import { cells, rows, scene } from './pixels'

const PANE = 'gamba'
const CABINET = 'cabinet' // the Raster's key in the pane
const GLOW_MS = [0, 500, 1200] // how long a miss, a pair and three of a kind celebrate
const IDLE_MS = 500 // a step of the sign's lights while nothing spins
const LIGHT_TICKS = 3 // and while the reels run: every third frame
const STREAK_FROM = 5
const DEP_MS = 5000 // how long the agent line shows a deposit
// Prompts the person wrote themselves, the ones the language is read from.
const TYPED = ['composer', 'bridge', 'sdk']

// What /gamba <word> <number> may set, and the bounds of each.
const SETTINGS = { rate: [1, 1_000_000], cap: [1, 1000], warn: [1, 100] } as const
let save: Save = fresh() // the store's copy as of the last load
let queue: Promise<unknown> = Promise.resolve()
let turn = { chips: 0, tokens: 0 } // deposited since the person's turn started, subagents' included
// Chips each running turn has deposited, by turnId: the cap holds per agent
// turn. One shared count let a background workflow's agents hit the main
// turn's cap and deposit nothing for the rest of the run.
const earned = new Map<string, number>()
let at: number[] = fresh().rest // where on the strip each reel is, a fraction while it moves
let hits = [false, false, false] // the reels that won the last spin
let drawn: Parts | undefined // the pixel cabinet the pane drew last; absent, it drew text
let isSpinning = false
let held = 0 // the part of a win the balance has not shown yet
let granted = 0 // free spins the reels have won but not shown yet
let glow = 0 // the payline celebrates: 1 a pair, 2 three of a kind or free spins won
let before: Save | undefined // the records as they stood before the spin, while its reels roll
let isLit = false // the blink of the glow
let phase = 0 // frames drawn so far: LIGHT_TICKS of them move the running lights one bulb
let timer: Timer | undefined // the spin, or the idle lights
let later: Timer | undefined // the agent line's second phrase, on its way
let line = '' // what the slot says
let news = '' // what is going on with the agent
let offer = '' // the question above the prompt while the agent works; '' when not asking

async function load($: EngineInterface): Promise<void> {
  const stored = (await $.store.get('save')) as Partial<Save> | undefined
  save = { ...fresh(), ...stored }
  // A save from before bets: every spin in it staked one chip.
  if (stored?.wagered === undefined) save.wagered = save.spins
}

// Every change goes through here: re-read the store (another session may
// have written), apply, write back, redraw. Changes of this session queue.
// ponytail: two sessions writing in the same instant can still lose one
// write between get and set. Split the save into per-field keys if it bites.
function mutate<T>($: EngineInterface, change: (s: Save) => T): Promise<T> {
  const run = queue.then(async () => {
    await load($)
    rollWeek(save, await $.clock.now())
    const out = change(save)
    await $.store.set('save', save)
    $.ui.invalidate('ui.render')
    return out
  })
  queue = run.catch(() => {})
  return run
}

function locale(): Locale {
  return LOCALES[save.lang === 'auto' ? save.detected : save.lang] ?? LOCALES[FALLBACK]!
}

function say(key: keyof Phrases, vars: Record<string, number | string> = {}): string {
  const t = locale()
  return fill(t, pick(t[key], key), vars)
}

function hours(t: Locale): string {
  return (save.week.waitedMs / 3_600_000).toFixed(1).replace('.', t.decimal)
}

function share(): string {
  const t = locale()
  return fill(t, t.share, {
    hours: hours(t),
    spins: save.week.spins,
    tokens: save.week.tokens,
    rank: t.ranks[rank(save.spins)]!,
  })
}

function outcome(win: number, tier: number): string {
  if (tier === 2) return say('big')
  if (win > 0) return say('small')
  if (save.chips < 1 && save.free < 1) return say('broke')
  return save.missStreak >= STREAK_FROM ? say('streak', { n: save.missStreak }) : say('miss')
}

// `byHand`: the person asked for it, so it may take the keyboard.
function show($: EngineInterface, byHand: boolean) {
  // Above the prompt the pane is as tall as what it draws, up to these rows.
  return $.ui.open({ id: PANE, title: 'gamba', rows: 23, ...(byHand ? { focus: true as const } : {}) })
}

function sfx($: EngineInterface, name: 'stop' | 'win' | 'big' | 'broke'): void {
  // No player (Linux, Windows) or no file: the slot just stays quiet.
  if (save.sound) $.audio.play({ asset: `sounds/${name}.wav` }).catch(() => {})
}

// The cabinet as the pane's Raster takes it.
function picture(parts: Parts): string {
  return cells(
    scene(parts, {
      title: locale().title,
      at,
      phase: Math.floor(phase / LIGHT_TICKS),
      frame: phase,
      glow,
      isLit,
      hits,
      balance: save.chips - held,
      isPaying: glow > 0, // not before the reels are down: the color would give the win away
    }),
  )
}

// The picture moved. Pixels are repainted in place; a pane drawn in text, or
// one whose words changed too, is drawn again.
// ponytail: one pane at a time. With the slot on two surfaces at once the one
// drawn last animates and the other catches up when the words change.
function redraw($: EngineInterface, isWords: boolean): void {
  if (drawn === undefined || isWords) $.ui.invalidate('ui.render')
  else $.ui.blit({ requestId: PANE, key: CABINET, cells: picture(drawn) }).catch(() => {})
}

// The sign's lights keep running while the slot stands idle on screen.
function idle($: EngineInterface): void {
  const mine = $.clock.every(IDLE_MS, async () => {
    phase += LIGHT_TICKS
    const blit = drawn?.hasSign && (await $.ui.blit({ requestId: PANE, key: CABINET, cells: picture(drawn) }))
    // No sign on screen: nothing to light until the pane draws one again.
    if (blit && blit.deny === undefined) return
    mine.cancel()
    if (timer === mine) timer = undefined
  })
  timer = mine
}

async function pull($: EngineInterface): Promise<void> {
  if (isSpinning) return
  isSpinning = true
  const reels: Reels = spin()
  // The spin is settled and saved before the reels move: closing the pane
  // mid-animation changes nothing.
  const planned = plan(reels)
  const spun = await mutate($, s => {
    if (s.chips < 1 && s.free < 1) return undefined
    before = { ...s, week: { ...s.week } } // the records would give the result away
    s.rest = planned.rest // a reopened pane shows the last real result, not a made-up one
    const wasFree = s.free > 0
    const win = applySpin(s, reels)
    return { win, wasFree, free: s.free, freeWon: s.freeWon }
  })
  if (spun === undefined) {
    isSpinning = false
    line = say('broke')
    sfx($, 'broke')
    $.ui.invalidate('ui.render')
    return
  }
  const { win, wasFree, free, freeWon } = spun
  timer?.cancel() // the last win may still be celebrating
  glow = 0
  held = win
  // A paid spin that ends with free spins left has just won them.
  granted = wasFree ? 0 : free
  line = say('spin')
  const tier = payout(reels) > PAIR_PAY || granted > 0 ? 2 : win > 0 ? 1 : 0
  const down = planned.stops[2]! // the last reel stops
  const end = down + Math.max(GLOW_MS[tier]!, BOUNCE_MS)
  let tick = 0
  timer = $.clock.every(FRAME_MS, () => {
    tick += 1
    const ms = tick * FRAME_MS
    const isNow = (moment: number) => ms >= moment && ms - FRAME_MS < moment
    let isWords = false
    phase += 1
    at = where(planned, ms)
    if (planned.stops.some(isNow)) sfx($, 'stop')
    if (isNow(down)) {
      // The reels are down. The next spin may start over the celebration.
      isSpinning = false
      before = undefined
      glow = tier
      hits = reels.map((symbol, i) =>
        granted > 0 ? symbol === SCATTER : win > 0 && (i < 2 || symbol === reels[0]),
      )
      // The last free spin sums them all up, its own win included.
      const isLast = wasFree && free === 0
      const said =
        granted > 0 ? say('bonus', { n: granted }) : isLast ? say('bonusEnd', { n: freeWon }) : outcome(win, tier)
      line = win > 0 && !isLast ? `${said}  +${win}` : said
      granted = 0
      if (tier > 0) sfx($, tier === 2 ? 'big' : 'win')
      else if (save.chips < 1 && save.free < 1) sfx($, 'broke')
      isWords = true
    }
    if (ms >= down && tier > 0) {
      isLit = Math.floor((ms - down) / 100) % 2 === 0
      held = Math.max(0, held - Math.ceil((win * FRAME_MS) / GLOW_MS[tier]!)) // the balance counts up
      // Counted up in text: drawn again every third frame, the pixels in place between.
      if (drawn?.hasBank === false && tick % 3 === 0) isWords = true
    }
    if (ms >= end) {
      timer?.cancel()
      timer = undefined
      glow = held = 0
      isWords = true
    }
    redraw($, isWords)
  })
}

// The settings as text, with how to change them.
function settings(): string {
  const t = locale()
  const l = t.labels
  const now = `${l.rate}: ${fill(t, '{n}', { n: save.rate })} · ${l.cap}: ${save.cap} · ${l.warn}: ${save.warn}%`
  return `${now}\n/gamba rate N · /gamba cap N · /gamba warn N`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await load($)
    at = save.rest
    $.ui.invalidate('ui.render') // a pane left open across a reload
    await $.command.register({
      name: 'gamba',
      description: 'Spin the slot while your agent works',
      argumentHint: '[stats | config | rate N | cap N | warn N]',
      immediate: true,
    })
    // The same command under its Russian name.
    await $.command.register({
      name: 'ludka',
      description: 'Покрутить слот, пока агент работает',
      argumentHint: '[stats | config | rate N | cap N | warn N]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: ['gamba', 'ludka'] }, async ($, e) => {
    await load($)
    const [word = '', value = ''] = e.args.trim().split(/\s+/)
    if (word === 'stats') return { text: share() }
    // Nothing is asked at install: the defaults stand until one of these changes them.
    if (word === 'config') return { text: settings() }
    if (word === 'rate' || word === 'cap' || word === 'warn') {
      const [least, most] = SETTINGS[word]
      const n = Number(value)
      if (Number.isInteger(n) && n >= least && n <= most) {
        await mutate($, s => {
          s[word] = n
        })
      }
      return { text: settings() }
    }
    offer = ''
    if (!save.seen) {
      line = say('first')
      await mutate($, s => {
        s.seen = true
      })
    } else if (save.chips < 1 && save.free < 1 && !isSpinning) {
      line = say('broke')
    }
    const opened = await show($, true)
    // Where nothing draws a pane, the stats are still worth a line.
    return opened.isPlaced ? {} : { text: share() }
  })

  on('prompt.submit', async ($, e, next) => {
    const code = TYPED.includes(e.origin.kind) ? detect(e.text) : undefined
    if (code !== undefined && code !== save.detected) {
      line = news = '' // said in the old language
      await mutate($, s => {
        s.detected = code
      })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turn = { chips: 0, tokens: 0 }
    later?.cancel()
    news = say('agentStart')
    // The agent is off working. If the slot is not on screen: open it, offer
    // it above the prompt, or leave the person alone, as they chose.
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    // A pane nobody asked for never takes the keyboard, and a narrow terminal
    // does not seat it at all: then the offer stands in for it.
    const isAsking = !isUp && (save.offer === 'ask' || (save.offer === 'always' && !(await show($, false)).isPlaced))
    offer = isAsking ? say('offer') : ''
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Chips arrive request by request, so a long turn pays out while it runs.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage) {
      const tokens = burned(result.usage)
      // The room under the cap is read inside the queue: subagents step in parallel.
      await mutate($, s => {
        const had = earned.get(e.turnId) ?? 0
        const chips = deposit(s, tokens, s.rate, s.cap - had)
        earned.set(e.turnId, had + chips)
        turn.chips += chips
        turn.tokens += tokens
      })
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    earned.delete(e.turnId)
    // A subagent's turn: its tokens were deposited step by step already.
    if (e.agentId !== undefined) return next(e)
    offer = '' // nothing left to wait for
    // The deposit is the agent's news, not the reels': under the reels a
    // "+10" reads as a win. It gets a few seconds, then the nudge back to work.
    later?.cancel()
    if (turn.chips > 0) {
      news = say('dep', turn)
      later = $.clock.after(DEP_MS, () => {
        news = say('agentDone')
        $.ui.invalidate('ui.render')
      })
    } else {
      news = say('agentDone')
    }
    await mutate($, s => {
      s.week.waitedMs += e.durationMs
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const weekly = e.rateLimits
      .filter(limit => limit.kind.startsWith('seven_day'))
      .sort((a, b) => b.percentUsed - a.percentUsed)[0]
    await load($)
    if (weekly !== undefined && weekly.percentUsed >= save.warn) {
      const now = await $.clock.now()
      if (now >= save.warnedUntil) {
        news = say('limit', { pct: Math.floor(weekly.percentUsed) })
        $.ui.toast(news)
        // Quiet until this window resets, however often it is measured.
        const until = Date.parse(weekly.resetsAt ?? '') || now + WEEK_MS
        await mutate($, s => {
          s.warnedUntil = until
        })
      }
    }
    return next(e)
  })

  // The offer: one line above the prompt. Its digits work from an empty
  // prompt, so it takes nothing from the person who ignores it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (offer === '' || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const l = locale().labels
    // "Always" is already chosen and the terminal just would not seat the
    // pane unasked: then the question is only whether to open it now.
    const isChosen = save.offer === 'always'
    const answer = (mode: Offer | undefined, isOpening: boolean) => async () => {
      offer = ''
      if (mode !== undefined) {
        await mutate($, s => {
          s.offer = mode
        })
      }
      $.ui.invalidate('ui.render')
      if (isOpening) await show($, true)
    }
    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 2,
          children: [
            Text({ color: 'yellow', children: [`🎰 ${offer}`] }),
            Button({ key: 'offer-yes', label: l.yes, hotkey: '1', plain: true, onPress: answer(undefined, true) }),
            Button({ key: 'offer-no', label: l.no, hotkey: '2', plain: true, onPress: answer(undefined, false) }),
            ...(isChosen
              ? []
              : [
                  Button({ key: 'offer-always', label: l.always, hotkey: '3', plain: true, onPress: answer('always', true) }),
                  Button({ key: 'offer-never', label: l.never, hotkey: '4', plain: true, onPress: answer('never', false) }),
                ]),
          ],
        }),
        await next(e),
      ],
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const t = locale()
    const l = t.labels
    const columns = e.props.bodyColumns
    const isDocked = e.props.placement === 'dock'
    // Only the terminal draws a Raster; the other surfaces take one and show nothing.
    const height = isDocked ? e.props.scroll.bodyRows : (e.viewport?.rows ?? 0)
    const view = layout(e.props.placement, columns, height, e.surface === 'terminal')
    drawn = view.cabinet
    if (timer === undefined && drawn?.hasSign) idle($)
    // Beside the pixel reels everything stands in a column, flush left.
    const isAside = view.isAside === true
    const isRoomy = view.isWide
    const isOn = glow > 0 && isLit
    const blink = glow > 0 ? (isLit ? 'lit' : 'dark') : undefined
    const gold = { color: 'yellow' } as const
    const tint = isOn ? { color: glow === 2 ? 'yellow' : 'green' } : isRoomy ? gold : {}
    const balance = save.chips - held
    const center = { flexDirection: 'column', alignItems: 'center' } as const

    const [top, above, payline, below, bottom] = reelWindow(at.map(Math.round), isRoomy)
    const reels = [
      Text({ dimColor: !isOn && !isRoomy, ...tint, children: [top!] }),
      Text({ dimColor: true, children: [above!] }),
      Text({ bold: true, inverse: isOn && glow === 2, ...tint, children: [payline!] }),
      Text({ dimColor: true, children: [below!] }),
      Text({ dimColor: !isOn && !isRoomy, ...tint, children: [bottom!] }),
    ]
    const said = Text({ bold: true, ...(glow === 2 ? gold : {}), children: [line || ' '] })
    const agent = Text({ dimColor: true, children: [news || ' '] })

    const flow = {
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 2,
      ...(isRoomy && !isAside ? ({ justifyContent: 'center' } as const) : {}),
    } as const
    // The stake: 2 and 3 step left and right through the stakes, a click
    // picks one outright. The chosen one is a gold chip, the rest are dim.
    const step = (by: number) => () =>
      mutate($, s => {
        const next = Math.max(0, BETS.indexOf(s.bet)) + by
        s.bet = BETS[Math.max(0, Math.min(BETS.length - 1, next))]!
      })
    const bets = Box({
      ...flow,
      children: [
        Text({ dimColor: true, children: [l.bet] }),
        Button({ key: 'bet-down', label: '◄', hotkey: '2', plain: true, onPress: step(-1) }),
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: BETS.map(bet =>
            bet === save.bet
              ? Text({ bold: true, inverse: true, ...gold, children: [` ${bet} `] })
              : Button({
                  key: `bet-${bet}`,
                  label: String(bet),
                  plain: true,
                  dimColor: true,
                  onPress: () =>
                    mutate($, s => {
                      s.bet = bet
                    }),
                }),
          ),
        }),
        Button({ key: 'bet-up', label: '►', hotkey: '3', plain: true, onPress: step(1) }),
      ],
    })
    // While free spins last the stake is fixed: the row counts them down instead.
    const free = save.free - granted
    const counter = Text({
      bold: true,
      ...gold,
      children: [`${l.free}: ${free} · ${l.bet} ${save.freeBet} ×${FREE_MULT}`],
    })
    // Digits, not letters: they press the same on any keyboard layout. The
    // game is on 1 to 3; the settings after them are drawn dim.
    const buttons = Box({
      ...flow,
      children: [
        Button({ key: 'spin', label: l.spin, hotkey: '1', plain: true, autoFocus: true, onPress: () => pull($) }),
        Button({
          key: 'copy',
          label: l.copy,
          hotkey: '4',
          plain: true,
          dimColor: true,
          onPress: async press => {
            const copy = await $.ui.copy({ text: share(), surface: press.surface })
            news = copy.isCopied ? l.copied : l.copyFailed
            $.ui.invalidate('ui.render')
          },
        }),
        Button({
          key: 'lang',
          label: `${l.lang}: ${save.lang}`,
          hotkey: '5',
          plain: true,
          dimColor: true,
          onPress: () => {
            line = news = ''
            return mutate($, s => {
              const order = ['auto', ...Object.keys(LOCALES)]
              s.lang = order[(order.indexOf(s.lang) + 1) % order.length]!
            })
          },
        }),
        Button({
          key: 'sound',
          label: `${l.sound}: ${save.sound ? l.on : l.off}`,
          hotkey: '6',
          plain: true,
          dimColor: true,
          onPress: () =>
            mutate($, s => {
              s.sound = !s.sound
            }),
        }),
        Button({
          key: 'offer',
          label: `${l.offer}: ${l.offers[save.offer]}`,
          hotkey: '7',
          plain: true,
          dimColor: true,
          onPress: () =>
            mutate($, s => {
              s.offer = OFFERS[(OFFERS.indexOf(s.offer) + 1) % OFFERS.length]!
            }),
        }),
        Button({
          key: 'close',
          label: l.close,
          hotkey: '8',
          plain: true,
          dimColor: true,
          onPress: () => $.ui.close({ id: PANE }),
        }),
      ],
    })

    const shown = before ?? save
    const records: [string, number | string][] = [
      [l.rank, t.ranks[rank(shown.spins)]!],
      [l.maxWin, shown.maxWin > 0 ? fill(t, '{n}', { n: shown.maxWin }) : '—'],
      [l.streak, shown.maxMissStreak],
      [l.payout, shown.wagered > 0 ? `${Math.round((shown.won / shown.wagered) * 100)}%` : '—'],
    ]
    const weekly: [string, number | string][] = [
      [l.waited, fill(t, l.hours, { hours: hours(t) })],
      [l.spins, fill(t, '{n}', { n: shown.week.spins })],
      [l.tokens, fill(t, '{n}', { n: save.week.tokens })],
    ]

    const pair = (width: number) => ([label, value]: [string, number | string]) =>
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        width,
        children: [Text({ dimColor: true, children: [label] }), Text({ bold: true, children: [String(value)] })],
      })
    const list = (width: number) => [
      ...records.map(pair(width)),
      Box({ justifyContent: 'center', width, children: [Text({ dimColor: true, children: [`· ${l.week} ·`] })] }),
      ...weekly.map(pair(width)),
    ]
    // The same numbers as two wrapping lines, for a pane with no room for a card.
    const words = ([label, value]: [string, number | string]) =>
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [Text({ dimColor: true, children: [label] }), Text({ bold: true, children: [String(value)] })],
      })
    const wrap = {
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 3,
      ...(isAside ? {} : ({ justifyContent: 'center' } as const)),
    } as const
    const weekLine = Box({
      ...wrap,
      children: [Text({ dimColor: true, children: [`${l.week}:`] }), ...weekly.map(words)],
    })
    const lines = [Box({ ...wrap, children: records.map(words) }), weekLine]

    // The balance: three rows tall where there is room, green while a win is
    // being counted in; one line of text where there is not.
    const bank =
      view.bank === 'line'
        ? Text({ bold: true, ...gold, children: [`${l.balance}: ${balance}`] })
        : Box({
            ...center,
            children: [
              ...(isAside ? [] : [Text({ dimColor: true, children: [[...l.balance.toUpperCase()].join(' ')] })]),
              ...big(String(balance)).map(row =>
                Text({ bold: true, color: glow > 0 ? 'green' : 'yellow', children: [row] }),
              ),
            ],
          })

    const width = Math.min(43, columns)
    const card = { flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, width } as const
    const lights = (shift: number) =>
      Text({ ...gold, children: [bulbs(32, Math.floor(phase / LIGHT_TICKS) + shift, blink)] })
    const window =
      drawn !== undefined && 'Raster' in elements
        ? elements.Raster({ key: CABINET, columns: WIDTH, rows: rows(drawn), cells: picture(drawn) })
        : Box({ ...center, children: reels })
    const isBeside = view.bank === 'beside' && !isAside
    // Under the pixel reels every row counts: a one-line balance shares the stake's.
    const isPurse = drawn !== undefined && view.bank === 'line'
    const stake = Box({ ...flow, columnGap: 3, children: [...(isPurse ? [bank] : []), free > 0 ? counter : bets] })
    const stats = [
      ...(view.stats === 'card' ? [Box({ ...card, children: list(width - 4) })] : []),
      ...(view.stats === 'lines' ? lines : []),
      ...(view.stats === 'split' ? [weekLine] : []),
    ]

    if (isAside) {
      return Box({
        flexDirection: 'row',
        alignItems: 'center',
        columnGap: 3,
        children: [
          window,
          Box({ flexDirection: 'column', alignItems: 'flex-start', children: [bank, said, stake, buttons, agent, ...stats] }),
        ],
      })
    }
    return Box({
      ...(isRoomy ? { ...center, width: columns } : { flexDirection: 'column' }),
      rowGap: view.gap,
      children: [
        ...(view.hasTitle
          ? [
              Box({
                ...center,
                children: [
                  lights(0),
                  ...big(t.title).map(row => Text({ bold: true, color: 'red', children: [row] })),
                  lights(1),
                ],
              }),
            ]
          : view.hasLights
            ? [lights(0)]
            : []),
        Box({
          ...center,
          children: [
            isBeside
              ? Box({
                  flexDirection: 'row',
                  alignItems: 'center',
                  columnGap: 3,
                  children: [
                    window,
                    bank,
                    ...(view.stats === 'split'
                      ? [Box({ flexDirection: 'column', children: records.map(pair(22)) })]
                      : []),
                  ],
                })
              : window,
            ...(drawn === undefined ? [said] : []),
          ],
        }),
        // Under the cabinet the phrase is a section of its own: the picture ends in a hard edge.
        ...(drawn === undefined ? [] : [said]),
        ...(isBeside || isPurse || view.bank === 'drawn' ? [] : [bank]),
        stake,
        Box({ ...(isRoomy ? { width: isDocked ? Math.min(columns, 58) : columns, justifyContent: 'center' } : {}), children: [buttons] }),
        agent,
        ...(view.hasPays
          ? [
              Box({
                ...card,
                children: [
                  Box({
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    columnGap: 3,
                    children: SYMBOLS.filter(symbol => symbol.pay > 0).map(symbol =>
                      Box({
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        width: 11,
                        children: [
                          Text({ children: [symbol.emoji.repeat(3)] }),
                          Text({ bold: true, ...gold, children: [String(symbol.pay * save.bet)] }),
                        ],
                      }),
                    ),
                  }),
                  pair(width - 4)([l.pair, PAIR_PAY * save.bet]),
                  pair(width - 4)([
                    `${l.free} ×${FREE_MULT}`,
                    [2, 3].map(n => `${SYMBOLS[SCATTER]!.emoji.repeat(n)} ${FREE_SPINS[n]}`).join(' · '),
                  ]),
                ],
              }),
            ]
          : []),
        ...stats,
      ],
    })
  })
}
