import { useEffect } from 'react'
import { Button } from '@fluentui/react-components'

interface ReferenceHelpDialogProps {
  onClose: () => void
}

const referenceKinds = [
  {
    title: '只显示链接',
    description: '显示目标标题或段落摘要；点击后打开原文并定位到对应内容块。',
    example: '↗ 项目计划',
  },
  {
    title: '嵌入原文内容',
    description: '在当前笔记中直接展示整篇、单个内容块或连续内容；原文变化后自动更新。',
    example: '引用 · 项目计划',
  },
  {
    title: '固定显示文字',
    description: '填写别名后始终显示自定义文字；留空则使用动态标题或段落内容。',
    example: '↗ 查看执行方案',
  },
]

export function ReferenceHelpDialog({ onClose }: ReferenceHelpDialogProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div className="settings-backdrop reference-help-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="settings-dialog reference-help-dialog" role="dialog" aria-modal="true" aria-label="双链使用说明">
      <header>
        <div>
          <span className="reference-help-eyebrow">双向链接</span>
          <h2>把笔记连接成自己的知识网络</h2>
          <p>在正文中输入 <kbd>[[</kbd> 和笔记标题，从补全中选择即可链接（写作 <code>[[笔记标题]]</code>）；需要引用段落或嵌入内容时，点击顶部的“双链”按钮。</p>
        </div>
        <Button appearance="subtle" onClick={onClose}>关闭</Button>
      </header>

      <ol className="reference-help-steps">
        <li><strong>标题链接</strong><span>输入 [[ 后按标题补全；链接到还不存在的笔记时，点击链接即可创建。笔记改名后，指向它的链接自动更新。</span></li>
        <li><strong>选择目标笔记</strong><span>可以搜索标题和正文，隐私笔记需先解锁。</span></li>
        <li><strong>选择引用范围</strong><span>链接整篇、单个内容块，或勾选相邻内容组成连续引用。</span></li>
        <li><strong>选择显示方式</strong><span>使用普通链接，或把原文内容直接嵌入当前笔记。</span></li>
      </ol>

      <div className="reference-help-kinds">
        {referenceKinds.map((kind) => <article key={kind.title}>
          <div className="reference-help-example">{kind.example}</div>
          <h3>{kind.title}</h3>
          <p>{kind.description}</p>
        </article>)}
      </div>

      <section className="reference-help-notes">
        <h3>引用之后会发生什么？</h3>
        <ul>
          <li>目标改名、移动到其他分区或调整层级后，链接仍然有效。</li>
          <li>右侧“引用”面板会列出链接到当前笔记的来源，方便反向追踪。</li>
          <li>原内容被删除时会显示失效提示；从回收站恢复后引用会重新显示。</li>
          <li>嵌入内容只在原文维护一份，不会复制出互相冲突的正文。</li>
        </ul>
      </section>

      <footer>
        <span>以后可随时按 <kbd>⌘P</kbd>，搜索“<strong>双链使用说明</strong>”。</span>
        <Button appearance="primary" onClick={onClose}>知道了</Button>
      </footer>
    </section>
  </div>
}
