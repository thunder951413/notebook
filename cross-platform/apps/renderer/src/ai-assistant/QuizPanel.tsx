import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import DOMPurify from 'dompurify'
import { AI_NOT_CONFIGURED, completeAI } from '../ai/completion'
import { documentToHtml, markdownToDocument } from '../editor/extensions'
import { pagePath } from '../ai/assistant'
import {
  CARDS_PER_NOTE_CHOICES,
  GRADES,
  QUIZ_MAX_NOTES,
  SESSION_LIMIT,
  addCards,
  deckStats,
  dueQueue,
  gradeCard,
  newCard,
  nextIntervalLabel,
  parseQuizCards,
  quizMessages,
  readDeck,
  shuffled,
  writeDeck,
  type Grade,
  type QuizCard,
} from '../ai/quiz'
import { failureMessage, organizablePages, type PlanPanelProps } from './OrganizePanel'

/** Notes with less text than this have nothing worth asking about. */
const MIN_NOTE_CHARACTERS = 30

function renderCardHtml(markdown: string) {
  try {
    // Card text is model output: sanitize before it reaches the DOM.
    return DOMPurify.sanitize(documentToHtml(markdownToDocument(markdown)), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] })
  } catch {
    return markdown.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!)
  }
}

type Session = { ids: string[]; tracked: boolean }

/**
 * 测验: the model turns the picked notes into question/answer cards. Study
 * them Anki-style (flip, then grade your own recall); graded cards come back
 * on a spaced schedule. The deck stays on this device.
 */
export function QuizPanel({ scopedPages, pages, notebooks, loadMarkdown, openPage, onNeedsSetup }: PlanPanelProps) {
  const candidates = organizablePages(scopedPages)
  const [deck, setDeck] = useState<QuizCard[]>(readDeck)
  const deckRef = useRef(deck)
  const [cardsPerNote, setCardsPerNote] = useState<number>(CARDS_PER_NOTE_CHOICES[1])
  const [request, setRequest] = useState('')
  const [session, setSession] = useState<Session>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [confirmClear, setConfirmClear] = useState(false)
  const abort = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => abort.current?.abort(), [])

  const commit = (next: QuizCard[]) => {
    deckRef.current = next
    setDeck(next)
    if (!writeDeck(next)) setError('无法保存题目：浏览器存储空间不足')
  }

  // The pick list starts over (first notes picked) whenever the scope changes.
  const scopeKey = candidates.map((page) => page.id).join(',')
  const [pickState, setPickState] = useState<{ key: string; ids: Set<string> }>()
  const picked = pickState?.key === scopeKey ? pickState.ids : new Set(candidates.slice(0, QUIZ_MAX_NOTES).map((page) => page.id))
  const setPicked = (next: Set<string>) => setPickState({ key: scopeKey, ids: next })
  useEffect(() => { setConfirmClear(false) }, [scopeKey])

  const scopeIds = new Set(candidates.map((page) => page.id))
  const scoped = deck.filter((card) => scopeIds.has(card.pageId))
  const now = Date.now()
  const stats = deckStats(scoped, now)
  const cardCount = (pageId: string) => deck.filter((card) => card.pageId === pageId).length

  const generate = async () => {
    if (busy || !picked.size) return
    const controller = new AbortController()
    abort.current = controller
    setError(undefined)
    setNotice(undefined)
    const chosen = candidates.filter((page) => picked.has(page.id))
    const problems: string[] = []
    let added = 0
    try {
      for (const [position, page] of chosen.entries()) {
        const title = page.title || '无标题'
        setBusy(`AI 正在出题 ${position + 1} / ${chosen.length}：${title}`)
        const markdown = (await loadMarkdown(page.id)) ?? ''
        if (markdown.trim().length < MIN_NOTE_CHARACTERS) { problems.push(`“${title}”内容太少，没有出题`); continue }
        try {
          const answer = await completeAI(quizMessages({ title: page.title, markdown }, cardsPerNote, request), controller.signal)
          const parsed = parseQuizCards(answer, cardsPerNote + 4)
          if (!parsed.length) { problems.push(`“${title}”没有生成可用的题目`); continue }
          const created = Date.now()
          const result = addCards(deckRef.current, parsed.map((card) => newCard({ pageId: page.id, pageTitle: title, ...card }, created)))
          commit(result.deck)
          added += result.added
          if (!result.added) problems.push(`“${title}”的题目都已经在题库里`)
        } catch (cause) {
          if (controller.signal.aborted) throw cause
          if (cause instanceof Error && cause.message === AI_NOT_CONFIGURED) { onNeedsSetup(); throw cause }
          problems.push(`“${title}”出题失败：${failureMessage(cause)}`)
        }
      }
    } catch (cause) {
      problems.push(failureMessage(cause))
    } finally {
      setBusy(undefined)
      abort.current = undefined
    }
    if (added) setNotice(`新增 ${added} 张题目`)
    if (problems.length) setError(problems.join('；'))
  }

  const start = (tracked: boolean) => {
    const queue = tracked ? dueQueue(scoped, Date.now()) : shuffled(scoped)
    if (queue.length) setSession({ ids: queue.map((card) => card.id), tracked })
  }

  const clearScope = () => {
    commit(deckRef.current.filter((card) => !scopeIds.has(card.pageId)))
    setConfirmClear(false)
    setNotice('已清除范围内的题目')
  }

  if (session) {
    return <StudySession
      session={session}
      cards={deck}
      pages={pages}
      onGrade={(card) => commit(deckRef.current.map((item) => item.id === card.id ? card : item))}
      onDelete={(cardId) => commit(deckRef.current.filter((item) => item.id !== cardId))}
      openPage={openPage}
      onExit={() => setSession(undefined)}
    />
  }

  const toggle = (id: string) => { const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id); setPicked(next) }
  const tooMany = picked.size > QUIZ_MAX_NOTES

  return <div className="organize">
    <div className="organize-scroll">
      <div className="quiz-overview">
        <div className="quiz-stats" aria-label="题库">
          <div><strong>{stats.total}</strong><span>范围内的题目</span></div>
          <div><strong>{stats.due}</strong><span>今天要复习</span></div>
          <div><strong>{stats.fresh}</strong><span>还没学过</span></div>
        </div>
        <div className="organize-actions">
          <Button appearance="primary" size="small" disabled={!stats.due} onClick={() => start(true)}>{stats.due ? `开始复习（${Math.min(stats.due, SESSION_LIMIT)} 张）` : '今天没有要复习的'}</Button>
          <Button size="small" disabled={!stats.total} onClick={() => start(false)}>全部练习一遍</Button>
          {stats.total > 0 && (confirmClear
            ? <><Button size="small" onClick={clearScope}>确认清除 {stats.total} 张</Button><Button size="small" appearance="subtle" onClick={() => setConfirmClear(false)}>取消</Button></>
            : <Button size="small" appearance="subtle" onClick={() => setConfirmClear(true)}>清除题目</Button>)}
        </div>
        <p className="settings-note">复习：看到问题先回忆，翻开答案后给自己打分，答得越好，下次出现越晚。“全部练习一遍”随机出范围内所有题，不影响复习计划。</p>
      </div>

      <h3 className="quiz-heading">用笔记出题</h3>
      <div className="organize-modes quiz-count" role="radiogroup" aria-label="每篇出题数量">
        {CARDS_PER_NOTE_CHOICES.map((count) => <label key={count} className={`organize-mode ${cardsPerNote === count ? 'selected' : ''}`}>
          <input type="radio" name="quiz-count" checked={cardsPerNote === count} onChange={() => setCardsPerNote(count)} />
          <strong>每篇 {count} 题</strong>
        </label>)}
      </div>
      <textarea className="organize-request" rows={2} value={request} placeholder="补充要求（可选），例如“多考命令和参数”“只考步骤顺序”" onChange={(event) => setRequest(event.currentTarget.value)} />
      <div className="assistant-results-bar">
        <span>选了 {picked.size} / {candidates.length} 篇{tooMany ? `；一次最多 ${QUIZ_MAX_NOTES} 篇` : ''}。已有的题不会重复生成。</span>
        <button type="button" onClick={() => setPicked(picked.size ? new Set() : new Set(candidates.slice(0, QUIZ_MAX_NOTES).map((page) => page.id)))}>{picked.size ? '全不选' : '全选'}</button>
      </div>
      {!candidates.length && <div className="assistant-empty"><strong>范围里没有笔记</strong><span>用右上角的“范围”选几篇笔记。私密笔记和任务不会出题。</span></div>}
      <ul className="organize-picklist">
        {candidates.map((page) => <li key={page.id}><label>
          <input type="checkbox" checked={picked.has(page.id)} onChange={() => toggle(page.id)} />
          <span>{page.title || '无标题'}</span>
          <small>{cardCount(page.id) ? `已有 ${cardCount(page.id)} 题 · ` : ''}{pagePath(page, pages, notebooks)}</small>
        </label></li>)}
      </ul>
      {busy && <div className="assistant-busy organize-busy" role="status">{busy}</div>}
      {notice && <div className="quiz-notice" role="status">{notice}</div>}
      {error && <div className="organize-error" role="alert">{error}</div>}
    </div>
    <footer className="organize-foot">
      <span>题目由 AI 根据笔记原文生成，只保存在这台设备上，不会改动笔记，也不会同步。</span>
      {busy && <Button size="small" onClick={() => abort.current?.abort()}>停止</Button>}
      <Button appearance="primary" size="small" disabled={!picked.size || tooMany || Boolean(busy)} onClick={() => void generate()}>{busy ? '出题中…' : `为 ${picked.size} 篇出题`}</Button>
    </footer>
  </div>
}

interface StudyProps {
  session: Session
  cards: QuizCard[]
  pages: PlanPanelProps['pages']
  onGrade(card: QuizCard): void
  onDelete(cardId: string): void
  openPage(pageId: string): void
  onExit(): void
}

/** One pass through the queued cards. A card marked “忘了” returns at the end of the pass. */
function StudySession({ session, cards, pages, onGrade, onDelete, openPage, onExit }: StudyProps) {
  const [queue, setQueue] = useState(session.ids)
  const [position, setPosition] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [typed, setTyped] = useState('')
  const [tally, setTally] = useState<Record<Grade, number>>({ again: 0, hard: 0, good: 0, easy: 0 })
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards])
  // A card deleted mid-session is skipped.
  let at = position
  while (at < queue.length && !byId.has(queue[at]!)) at += 1
  const card = byId.get(queue[at] ?? '')
  const reviewed = tally.again + tally.hard + tally.good + tally.easy
  const answerHtml = useMemo(() => card ? renderCardHtml(card.answer) : '', [card])
  const questionHtml = useMemo(() => card ? renderCardHtml(card.question) : '', [card])

  const next = (id: string, again: boolean) => {
    if (again) setQueue((current) => [...current, id])
    setPosition(at + 1)
    setRevealed(false)
    setTyped('')
  }
  const grade = (value: Grade) => {
    if (!card || !revealed) return
    if (session.tracked) onGrade(gradeCard(card, value, Date.now()))
    setTally((current) => ({ ...current, [value]: current[value] + 1 }))
    next(card.id, value === 'again')
  }
  const remove = () => {
    if (!card) return
    onDelete(card.id)
    next(card.id, false)
  }

  const handlers = useRef({ grade, reveal: () => setRevealed(true), revealed })
  handlers.current = { grade, reveal: () => setRevealed(true), revealed }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey) return
      const target = event.target instanceof Element ? event.target : undefined
      const entry = Boolean(target?.closest('textarea, input, select'))
      const control = Boolean(target?.closest('button, a'))
      if (!handlers.current.revealed) {
        if ((entry && (event.metaKey || event.ctrlKey) && event.key === 'Enter') || (!entry && !control && (event.key === ' ' || event.key === 'Enter'))) {
          event.preventDefault()
          handlers.current.reveal()
        }
        return
      }
      if (entry || event.metaKey || event.ctrlKey) return
      const index = ['1', '2', '3', '4'].indexOf(event.key)
      if (index >= 0) { event.preventDefault(); handlers.current.grade(GRADES[index]!.id) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!card) {
    const remembered = tally.good + tally.easy
    return <div className="organize">
      <div className="organize-scroll">
        <div className="assistant-empty quiz-done">
          <strong>{reviewed ? '这一轮完成了' : '没有题目了'}</strong>
          {reviewed > 0 && <span>共答了 {reviewed} 次：记得 {remembered}，吃力 {tally.hard}，忘了 {tally.again}。{session.tracked ? '答错的题稍后会再出现。' : '这一轮没有改动复习计划。'}</span>}
          <Button appearance="primary" size="small" onClick={onExit}>返回</Button>
        </div>
      </div>
    </div>
  }

  const now = Date.now()
  const source = pages.find((page) => page.id === card.pageId)
  const remaining = queue.slice(at).filter((id) => byId.has(id)).length
  return <div className="organize quiz-study">
    <div className="quiz-bar">
      <Button appearance="subtle" size="small" onClick={onExit}>结束</Button>
      <span>{session.tracked ? '复习' : '练习'} · 还剩 {remaining} 张</span>
    </div>
    <div className="organize-scroll">
      <article className="quiz-card" aria-label="题目">
        <button type="button" className="quiz-source" disabled={!source} onClick={() => openPage(card.pageId)}>来自《{source?.title || card.pageTitle || '无标题'}》</button>
        <div className="assistant-answer quiz-question" dangerouslySetInnerHTML={{ __html: questionHtml }} />
        {!revealed
          ? <>
            <textarea className="organize-request" rows={3} value={typed} aria-label="你的答案" placeholder="先自己回答（可选）…" onChange={(event) => setTyped(event.currentTarget.value)} />
            <Button appearance="primary" onClick={() => setRevealed(true)}>显示答案（空格）</Button>
          </>
          : <>
            {typed.trim() && <div className="quiz-typed"><small>你的答案</small><p>{typed}</p></div>}
            <div className="quiz-answer"><small>答案</small><div className="assistant-answer" dangerouslySetInnerHTML={{ __html: answerHtml }} /></div>
            <div className="quiz-grades" role="group" aria-label="自评">
              {GRADES.map((item, index) => <button key={item.id} type="button" className={`quiz-grade ${item.id}`} onClick={() => grade(item.id)}>
                <strong>{item.label}</strong>
                <small>{session.tracked ? nextIntervalLabel(card, item.id, now) : `按 ${index + 1}`}</small>
              </button>)}
            </div>
            <div className="quiz-card-actions">
              <small>按 1–4 打分{session.tracked ? '；按钮下方是下次出现的时间' : ''}</small>
              <button type="button" onClick={remove}>删除这张</button>
            </div>
          </>}
      </article>
    </div>
  </div>
}
