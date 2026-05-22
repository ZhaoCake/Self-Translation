/**
 * Content Script
 * 网页分屏翻译：左边原网页，右边翻译后的网页
 */

// ============ 类型定义 ============

interface TextNode {
    node: Text
    originalText: string
}

interface TranslationCache {
    [url: string]: { [text: string]: string }
}

interface PluginConfig {
    provider: string
    apiKeys: Record<string, string>
    targetLanguage: string
    concurrency: number
    enableCache: boolean
    translateMode: 'split' | 'inline' | 'bilingual'
    model: string
}

const DEFAULT_CONFIG: PluginConfig = {
    provider: 'deepseek',
    apiKeys: {},
    targetLanguage: 'zh-CN',
    concurrency: 3,
    enableCache: true,
    translateMode: 'split',
    model: 'deepseek-v4-flash',
}

const MessageType = {
    START_TRANSLATION: 'START_TRANSLATION',
    START_INLINE_TRANSLATION: 'START_INLINE_TRANSLATION',
    START_BILINGUAL_TRANSLATION: 'START_BILINGUAL_TRANSLATION',
    RESTORE_PAGE: 'RESTORE_PAGE',
    GET_CONFIG: 'GET_CONFIG',
} as const

// ============ 状态 ============

console.log('[LLM翻译] Content Script 已加载')

let isTranslating = false
let isSplitView = false
let splitContainer: HTMLDivElement | null = null
let notificationElement: HTMLDivElement | null = null
let leftIframe: HTMLIFrameElement | null = null
let rightIframe: HTMLIFrameElement | null = null

const translationCache: TranslationCache = {}

// 保存原始文本用于恢复
let originalTexts: Map<Text, string> = new Map()
let isInlineMode = false
let isBilingualMode = false
let insertedNodes: HTMLElement[] = [] // 记录插入的翻译节点

// ============ 消息监听 ============

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log('[LLM翻译] 收到消息:', message.type)

    if (message.type === MessageType.START_TRANSLATION) {
        startSplitTranslation()
        sendResponse({ success: true })
    } else if (message.type === MessageType.START_INLINE_TRANSLATION) {
        startInlineTranslation()
        sendResponse({ success: true })
    } else if (message.type === MessageType.START_BILINGUAL_TRANSLATION) {
        startBilingualTranslation()
        sendResponse({ success: true })
    } else if (message.type === MessageType.RESTORE_PAGE) {
        if (isInlineMode) {
            restoreInlinePage()
        } else if (isBilingualMode) {
            restoreBilingualPage()
        } else {
            restorePage()
        }
        sendResponse({ success: true })
    }

    return false
})

// ============ 主要功能 ============

async function startSplitTranslation() {
    if (isTranslating) {
        showNotification('翻译进行中...', 'info')
        return
    }

    if (isSplitView) {
        showNotification('已经是分屏模式', 'info')
        return
    }

    isTranslating = true
    updateFloatingButtonState('translating')  // 更新按钮状态

    try {
        const config = await getConfig()
        const apiKey = config.apiKeys[config.provider]

        if (!apiKey) {
            showNotification('请先配置 API Key', 'error')
            isTranslating = false
            updateFloatingButtonState('idle')
            return
        }

        // 获取当前页面 HTML
        const pageHTML = document.documentElement.outerHTML

        // 创建分屏并写入内容
        createSplitView(pageHTML)
        isSplitView = true

        // 等待 iframe 渲染
        await delay(1000)

        // 设置滚动同步
        setupScrollSync()

        showNotification('正在翻译...', 'info')

        // 翻译右边
        await translateRightPane(config)

        showNotification('✓ 翻译完成！', 'success')
        updateFloatingButtonState('done')  // 翻译完成

    } catch (error) {
        console.error('[LLM翻译] 错误:', error)
        showNotification(`失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error')
        updateFloatingButtonState('idle')
    } finally {
        isTranslating = false
    }
}

/**
 * 原网页翻译 - 直接在当前页面上翻译
 */
async function startInlineTranslation() {
    if (isTranslating) {
        showNotification('翻译进行中...', 'info')
        return
    }

    isTranslating = true
    isInlineMode = true
    updateFloatingButtonState('translating')

    try {
        const config = await getConfig()
        const apiKey = config.apiKeys[config.provider]

        if (!apiKey) {
            showNotification('请先配置 API Key', 'error')
            isTranslating = false
            updateFloatingButtonState('idle')
            return
        }

        showNotification('正在翻译...', 'info')

        // 直接在当前页面翻译
        await translateInline(config)

        showNotification('✓ 翻译完成！', 'success')
        updateFloatingButtonState('done')

    } catch (error) {
        console.error('[LLM翻译] 错误:', error)
        showNotification(`失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error')
        updateFloatingButtonState('idle')
    } finally {
        isTranslating = false
    }
}

/**
 * 在原网页上翻译
 */
async function translateInline(config: PluginConfig) {
    const currentURL = window.location.href
    const cacheKey = `${currentURL}|${config.targetLanguage}`

    // 初始化缓存
    if (!translationCache[cacheKey]) {
        translationCache[cacheKey] = {}
    }
    const cache = translationCache[cacheKey]

    // 收集文本节点（使用当前 document）
    const textNodes = collectTextNodes(document.body, document)
    console.log(`[LLM翻译] 原网页翻译：收集到 ${textNodes.length} 个文本节点`)

    if (textNodes.length === 0) {
        console.log('[LLM翻译] 没有找到需要翻译的文本')
        return
    }

    // 保存原始文本用于恢复
    originalTexts.clear()
    textNodes.forEach(nodeInfo => {
        originalTexts.set(nodeInfo.node, nodeInfo.originalText)
    })

    // 分离缓存和未缓存
    const uncachedNodes: TextNode[] = []

    textNodes.forEach(nodeInfo => {
        if (cache[nodeInfo.originalText]) {
            nodeInfo.node.textContent = cache[nodeInfo.originalText]
        } else {
            uncachedNodes.push(nodeInfo)
        }
    })

    const cachedCount = textNodes.length - uncachedNodes.length
    console.log(`[LLM翻译] 缓存命中 ${cachedCount}，需翻译 ${uncachedNodes.length}`)

    if (uncachedNodes.length === 0) {
        showNotification('✓ 从缓存加载完成！', 'success')
        return
    }

    // 分批翻译
    const batchSize = 12
    const concurrency = config.concurrency || 3
    let completed = cachedCount

    const batches: TextNode[][] = []
    for (let i = 0; i < uncachedNodes.length; i += batchSize) {
        batches.push(uncachedNodes.slice(i, i + batchSize))
    }

    const translateBatch = async (batch: TextNode[]): Promise<void> => {
        const texts = batch.map(n => n.originalText)
        try {
            const translations = await translateTexts(texts, config)
            batch.forEach((nodeInfo, idx) => {
                if (translations[idx] && translations[idx] !== nodeInfo.originalText) {
                    nodeInfo.node.textContent = translations[idx]
                    cache[nodeInfo.originalText] = translations[idx]
                }
            })
            completed += batch.length
            showNotification(`翻译中... ${completed}/${textNodes.length}`, 'info')
        } catch (error) {
            console.error('[LLM翻译] 批次翻译失败:', error)
            completed += batch.length
        }
    }

    for (let i = 0; i < batches.length; i += concurrency) {
        const concurrentBatches = batches.slice(i, i + concurrency)
        await Promise.allSettled(concurrentBatches.map(batch => translateBatch(batch)))

        if (i + concurrency < batches.length) {
            await delay(100)
        }
    }
}

/**
 * 收集需要翻译的块级元素 (Leaf Block Elements)
 * 策略升级：查找所有块级元素，排除那些包含其他块级子元素的元素。
 * 针对用户反馈的优化：增强对导航栏、菜单、文件列表等非正文区域的过滤。
 */
function collectTranslatableBlocks(root: Element): HTMLElement[] {
    // 1. 定义块级标签
    const blockTags = [
        'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li',
        'blockquote', 'td', 'th', 'pre', 'figcaption',
        'div', 'section', 'article', 'header', 'footer', 'main', 'aside'
    ]
    // 辅助：用于检测子元素的完整块级列表 (包含容器类)
    const containerTags = [...blockTags, 'ul', 'ol', 'table', 'form', 'dl', 'dt', 'dd']
    const blockSelector = containerTags.join(', ')

    // 判断是否为不需要翻译的文本
    const isSkippableBlock = (text: string): boolean => {
        if (!/[a-zA-Z]/.test(text)) return true // 没有字母
        if (/^[\d\s\p{P}\p{S}]*$/u.test(text)) return true // 纯数字符号
        if (/^(if|for|while|function|class|import|export|const|let|var|return)\b/.test(text)) return true // 代码关键字
        return false
    }

    // 2. 获取所有潜在的块级元素
    // 使用 Set 去重 (以防 selector 匹配重叠)
    const allBlocks = Array.from(root.querySelectorAll(blockTags.join(', '))) as HTMLElement[]
    const validBlocks: HTMLElement[] = []

    for (const el of allBlocks) {
        // 排除翻译插件自身的元素
        if (el.classList.contains('llm-bilingual-text')) continue
        if (el.closest('.llm-bilingual-text')) continue
        if (el.closest('.llm-translator-ignore')) continue // 预留扩展

        // 2. 这里的关键改动：排除导航栏 (NAV)
        // 绝大多数网站的正文不会放在 nav 标签里，通过排除它可以解决 BBC 导航栏乱掉的问题
        if (el.closest('nav')) continue

        // 3. 可见性检查
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            continue
        }

        // 4. 叶子块检测 (只翻译最底层)
        // 如果一个元素包含其他块级元素，它就不是叶子块（它的子元素会被后续遍历到）
        // 我们只翻译最底层的块。
        // 例如：<div> <p>Text</p> </div> -> Div 被跳过，P 被选中。
        // 例如：<li> <a href>Link</a> Text </li> -> Li 里面没有块级元素(A是行内)，所以 Li 被选中。-> 完美解决链接拆分问题
        if (el.querySelector(blockSelector)) {
            continue
        }

        // 5. 内容智能过滤
        const text = (el.innerText || el.textContent || '').trim()
        if (!text) continue
        if (isSkippableBlock(text)) continue

        const isHeader = /^H[1-6]$/.test(el.tagName)
        const wordCount = text.split(/\s+/).length

        // 6. 短文本过滤 (加强版)
        // 单词数少于 5 个通常不是正文句子 (例如 "3 days ago", "Commit message", "Read more")
        // 除非它是标题 (H1-H6)
        if (!isHeader && wordCount < 5) {
            // 允许例外：如果包含问号或感叹号，可能是对话
            if (!/[?!？！]/.test(text)) {
                continue
            }
        }

        // 7. 孤立链接检测 (Link-heavy block detection)
        // 解决 GitHub 文件列表、新闻列表等 "一行一个链接" 导致的布局破坏问题。
        // 如果一个块的文本主要由 <a> 标签构成，且不算太长，我们视为导航/列表链接，跳过。
        const links = el.getElementsByTagName('a')
        if (links.length > 0) {
            let linkTextLength = 0
            for (let i = 0; i < links.length; i++) {
                linkTextLength += (links[i].innerText || '').length
            }

            const totalLength = text.length
            // 如果链接文本占比超过 80% 且总长度小于 200 字符 (防止误伤超长标题)
            // 这通常意味着这是一个 "点击跳转" 的块，而不是 "阅读" 的块
            if (totalLength > 0 && (linkTextLength / totalLength) > 0.8 && totalLength < 200) {
                continue
            }
        }

        validBlocks.push(el)
    }

    return validBlocks
}

/**
 * 双语对照翻译 - 在原文下方插入译文
 */
async function startBilingualTranslation() {
    if (isTranslating) {
        showNotification('翻译进行中...', 'info')
        return
    }

    isTranslating = true
    isBilingualMode = true
    updateFloatingButtonState('translating')

    try {
        const config = await getConfig()
        const apiKey = config.apiKeys[config.provider]

        if (!apiKey) {
            showNotification('请先配置 API Key', 'error')
            isTranslating = false
            isBilingualMode = false // 重置状态
            updateFloatingButtonState('idle')
            return
        }

        const success = await translateBilingual(config)

        if (success) {
            showNotification('✓ 双语对照翻译完成！', 'success')
            updateFloatingButtonState('done')
        } else {
            // 如果没有翻译任何内容，重置状态
            isBilingualMode = false
            isTranslating = false
            updateFloatingButtonState('idle')
        }

    } catch (error) {
        console.error('[LLM翻译] 错误:', error)
        showNotification(`失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error')
        updateFloatingButtonState('idle')
        restoreBilingualPage() // 出错时回滚
    } finally {
        isTranslating = false
    }
}

async function translateBilingual(config: PluginConfig): Promise<boolean> {
    const currentURL = window.location.href
    const cacheKey = `${currentURL}|${config.targetLanguage}`

    // 初始化缓存
    if (!translationCache[cacheKey]) {
        translationCache[cacheKey] = {}
    }
    const cache = translationCache[cacheKey]
    // 1. 收集块级元素
    const blocks = collectTranslatableBlocks(document.body)
    console.log(`[LLM翻译] 双语翻译(Block模式)：收集到 ${blocks.length} 个块级元素`)

    if (blocks.length === 0) {
        showNotification('没有找到可翻译的文本块', 'info')
        return false // <--- 返回 false
    }

    const uncachedBlocks: { el: HTMLElement, text: string }[] = []

    // 插入译文块的辅助函数
    const insertTransBlock = (targetBlock: HTMLElement, translation: string) => {
        // 避免重复插入
        const lastChild = targetBlock.lastElementChild
        if (lastChild && lastChild.classList.contains('llm-bilingual-text')) {
            return
        }

        const transDiv = document.createElement('div')
        transDiv.className = 'llm-bilingual-text'
        transDiv.textContent = translation

        // 沉浸式样式
        transDiv.style.display = 'block'
        transDiv.style.marginTop = '6px'
        transDiv.style.marginBottom = '8px'
        transDiv.style.color = '#595959'
        transDiv.style.fontSize = '14px'
        transDiv.style.lineHeight = '1.6'
        transDiv.style.fontWeight = 'normal'
        transDiv.style.padding = '6px 10px'
        transDiv.style.backgroundColor = 'rgba(242, 243, 245, 0.6)'
        transDiv.style.borderLeft = '3px solid #667eea'
        transDiv.style.borderRadius = '4px'
        transDiv.style.width = 'fit-content'
        transDiv.style.maxWidth = '100%'
        transDiv.style.boxSizing = 'border-box'

        // 特殊处理标题
        if (/^H[1-6]$/.test(targetBlock.tagName)) {
            transDiv.style.marginTop = '8px'
            transDiv.style.fontWeight = 'bold'
            transDiv.style.fontSize = '15px'
        }

        targetBlock.appendChild(transDiv)
        insertedNodes.push(transDiv)
    }

    // 2. 检查缓存
    let hasContent = false
    blocks.forEach(el => {
        // 获取纯文本用于 key (忽略之前的翻译块如果是再次运行)
        // 简单的 innerText 可能会包含子元素的文本，这正是我们想要的（"Link: Description"）
        const text = (el.innerText || el.textContent || '').trim()

        if (text) hasContent = true // 确保有实际内容

        if (cache[text]) {
            insertTransBlock(el, cache[text])
        } else {
            uncachedBlocks.push({ el, text })
        }
    })

    // 如果全都是空文本块
    if (!hasContent) return false

    const cachedCount = blocks.length - uncachedBlocks.length
    console.log(`[LLM翻译] 缓存命中 ${cachedCount}，需翻译 ${uncachedBlocks.length}`)

    if (uncachedBlocks.length === 0) {
        if (cachedCount > 0) showNotification('✓ 从缓存加载完成！', 'success')
        return true // <--- 虽然不用翻译新内容，但展示了缓存，所以是成功
    }

    // 3. 分批翻译
    const batchSize = 8 // 块级文本通常较长，减小批大小
    const concurrency = config.concurrency || 3
    let completed = cachedCount

    const batches: { el: HTMLElement, text: string }[][] = []
    for (let i = 0; i < uncachedBlocks.length; i += batchSize) {
        batches.push(uncachedBlocks.slice(i, i + batchSize))
    }

    const translateBatch = async (batch: { el: HTMLElement, text: string }[]): Promise<void> => {
        const texts = batch.map(b => b.text)
        try {
            const translations = await translateTexts(texts, config)
            batch.forEach((item, idx) => {
                if (translations[idx]) {
                    insertTransBlock(item.el, translations[idx])
                    cache[item.text] = translations[idx]
                }
            })
            completed += batch.length
            showNotification(`翻译中... ${completed}/${blocks.length}`, 'info')
        } catch (error) {
            console.error('[LLM翻译] 批次翻译失败:', error)
            completed += batch.length
        }
    }

    for (let i = 0; i < batches.length; i += concurrency) {
        // Check filtering for bilingual logic
        const concurrentBatches = batches.slice(i, i + concurrency)
        await Promise.allSettled(concurrentBatches.map(batch => translateBatch(batch)))
        if (i + concurrency < batches.length) {
            await delay(100)
        }
    }

    return true // <--- 翻译流程完成
}

function restoreBilingualPage() {
    insertedNodes.forEach(node => node.remove())
    insertedNodes = []
    isBilingualMode = false
    updateFloatingButtonState('idle')
    showNotification('✓ 已恢复原页面', 'success')
    console.log('[LLM翻译] 双语对照翻译已恢复')
}

/**
 * 恢复原网页翻译
 */
function restoreInlinePage() {
    // 恢复所有原始文本
    originalTexts.forEach((originalText, node) => {
        if (node.parentNode) {
            node.textContent = originalText
        }
    })
    originalTexts.clear()
    isInlineMode = false
    updateFloatingButtonState('idle')
    showNotification('✓ 已恢复原页面', 'success')
    console.log('[LLM翻译] 原网页翻译已恢复')
}

/**
 * 创建分屏并使用 document.write 写入内容
 */
function createSplitView(pageHTML: string) {
    // 创建分屏容器
    splitContainer = document.createElement('div')
    splitContainer.id = 'llm-split-container'
    splitContainer.style.cssText = `
    position: fixed; top: 0; left: 0;
    width: 100vw; height: 100vh;
    display: flex; z-index: 2147483640;
    background: #fff;
  `

    // 左边 iframe
    leftIframe = document.createElement('iframe')
    leftIframe.id = 'llm-left-iframe'
    leftIframe.style.cssText = `
    width: 50%; height: 100%;
    border: none; border-right: 3px solid #667eea;
  `

    // 右边 iframe
    rightIframe = document.createElement('iframe')
    rightIframe.id = 'llm-right-iframe'
    rightIframe.style.cssText = `
    width: 50%; height: 100%; border: none;
  `

    // 标签
    const leftLabel = createLabel('📄 原文', 'left')
    const rightLabel = createLabel('🌐 译文', 'right')

    // 组装
    splitContainer.appendChild(leftIframe)
    splitContainer.appendChild(rightIframe)
    splitContainer.appendChild(leftLabel)
    splitContainer.appendChild(rightLabel)

    document.body.appendChild(splitContainer)
    document.body.style.overflow = 'hidden'

    // 使用 document.write 写入内容（这样可以保证能访问 contentDocument）
    writeHTMLToIframe(leftIframe, pageHTML)
    writeHTMLToIframe(rightIframe, pageHTML)

    console.log('[LLM翻译] 分屏创建完成')
}

/**
 * 写入 HTML 到 iframe
 */
function writeHTMLToIframe(iframe: HTMLIFrameElement, html: string) {
    const doc = iframe.contentDocument
    if (doc) {
        // 清理 HTML：移除 script 标签、浮动按钮、通知元素等
        let cleanHtml = html
        // 移除 script 标签
        cleanHtml = cleanHtml.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, "")
        // 移除我们的浮动按钮
        cleanHtml = cleanHtml.replace(/<button[^>]*id="llm-translate-fab"[^>]*>[\s\S]*?<\/button>/gmi, "")
        // 移除通知元素
        cleanHtml = cleanHtml.replace(/<div[^>]*id="llm-main-notification"[^>]*>[\s\S]*?<\/div>/gmi, "")
        // 移除我们注入的样式
        cleanHtml = cleanHtml.replace(/<style[^>]*id="llm-translate-styles"[^>]*>[\s\S]*?<\/style>/gmi, "")

        doc.open()
        doc.write(cleanHtml)
        doc.close()
    }
}

function createLabel(text: string, side: 'left' | 'right'): HTMLDivElement {
    const label = document.createElement('div')
    const leftPos = side === 'left' ? 'calc(25% - 30px)' : 'calc(75% - 30px)'
    label.style.cssText = `
    position: fixed; top: 50px; left: ${leftPos};
    padding: 6px 16px;
    background: ${side === 'left' ? 'rgba(0,0,0,0.7)' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'};
    color: white; border-radius: 15px;
    font-size: 13px; font-weight: 500;
    z-index: 2147483645;
    font-family: -apple-system, sans-serif;
    pointer-events: none;
  `
    label.textContent = text
    return label
}

function createExitButton(): HTMLButtonElement {
    const exitBtn = document.createElement('button')
    exitBtn.innerHTML = '✕ 退出分屏'
    exitBtn.style.cssText = `
    position: fixed; top: 10px; left: 50%;
    transform: translateX(-50%);
    padding: 8px 20px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white; border: none; border-radius: 20px;
    font-size: 14px; font-weight: 500; cursor: pointer;
    z-index: 2147483647;
    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
  `
    exitBtn.onclick = restorePage
    return exitBtn
}

/**
 * 设置滚动同步 - 调试 & 来源锁定版 (Debug & Source Locking)
 */
function setupScrollSync() {
    if (!leftIframe?.contentDocument || !rightIframe?.contentDocument) return

    const leftDoc = leftIframe.contentDocument
    const rightDoc = rightIframe.contentDocument
    const leftWin = leftIframe.contentWindow
    const rightWin = rightIframe.contentWindow

    if (!leftWin || !rightWin) return

    console.log('[Debug] 开始 setupScrollSync...')

    // 1. 打标 (Tagging)
    let elementCount = 0

    const mark = (l: Element, r: Element, path: string) => {
        l.setAttribute('data-sync-id', path)
        r.setAttribute('data-sync-id', path)
        elementCount++

        const len = Math.min(l.children.length, r.children.length)
        for (let i = 0; i < len; i++) {
            mark(l.children[i], r.children[i], `${path}-${i}`)
        }
    }

    mark(leftDoc.body, rightDoc.body, '0')
    console.log(`[Debug] DOM 打标完成，标记了 ${elementCount} 对元素`)

    // 2. 同步逻辑 (Source Locking)
    // 这种机制下，同一时间只有一个"主动方"
    let activeSource: 'left' | 'right' | null = null
    let lockTimer: any = null

    const handleScroll = (e: Event, side: 'left' | 'right') => {
        // 如果当前有其他主动方在控制，且不是我，则我是被动滚动的，忽略
        if (activeSource && activeSource !== side) {
            // console.log(`[Debug] ${side} 被动滚动，忽略`)
            return
        }

        // 锁定我是主动方
        activeSource = side
        if (lockTimer) clearTimeout(lockTimer)
        // 150ms 后释放锁定（此时惯性滚动可能还没停，但这能防止死循环）
        lockTimer = setTimeout(() => {
            activeSource = null
        }, 150)

        const target = e.target as Element | Document
        const targetDoc = side === 'left' ? rightDoc : leftDoc
        const targetWin = side === 'left' ? rightWin : leftWin

        try {
            // A. Window 滚动
            if (target === leftDoc || target === rightDoc) {
                const sWin = side === 'left' ? leftWin : rightWin
                // 简单的阈值判断，小于 2px 的差异不处理，减少抖动
                if (Math.abs(targetWin.scrollY - sWin.scrollY) > 2 || Math.abs(targetWin.scrollX - sWin.scrollX) > 2) {
                    targetWin.scrollTo(sWin.scrollX, sWin.scrollY)
                }
            }
            // B. 元素滚动
            else if (target instanceof Element) {
                const id = target.getAttribute('data-sync-id')
                if (!id) return // 没打标的元素不管

                const dest = targetDoc.querySelector(`[data-sync-id="${id}"]`)
                if (dest) {
                    // 同样增加阈值判断
                    const t = dest as Element
                    if (Math.abs(t.scrollTop - target.scrollTop) > 2 || Math.abs(t.scrollLeft - target.scrollLeft) > 2) {
                        t.scrollTop = target.scrollTop
                        t.scrollLeft = target.scrollLeft
                    }
                } else {
                    console.warn(`[Debug] 未找到对应元素 ID: ${id}`)
                }
            }
        } catch (err) {
            console.error('[Debug] 同步出错:', err)
        }
    }

    // 3. 绑定监听 (Capture)
    const opts = { capture: true, passive: true }

    leftDoc.addEventListener('scroll', (e) => handleScroll(e, 'left'), opts)
    rightDoc.addEventListener('scroll', (e) => handleScroll(e, 'right'), opts)

    // 额外监听 Window 上的 scroll
    leftWin.addEventListener('scroll', (e) => {
        if (e.target === leftDoc) handleScroll(e, 'left')
    }, opts)
    rightWin.addEventListener('scroll', (e) => {
        if (e.target === rightDoc) handleScroll(e, 'right')
    }, opts)

}

/**
 * 翻译右边面板 - 并发版
 */
async function translateRightPane(config: PluginConfig) {
    if (!rightIframe?.contentDocument) {
        console.error('[LLM翻译] 无法访问右侧 iframe')
        throw new Error('无法访问右侧 iframe')
    }

    const doc = rightIframe.contentDocument
    const currentURL = window.location.href
    const cacheKey = `${currentURL}|${config.targetLanguage}`

    console.log('[LLM翻译] 开始翻译:', currentURL)

    // 初始化缓存
    if (!translationCache[cacheKey]) {
        translationCache[cacheKey] = {}
    }
    const cache = translationCache[cacheKey]

    // 收集文本节点
    const textNodes = collectTextNodes(doc.body, doc)
    console.log(`[LLM翻译] 收集到 ${textNodes.length} 个文本节点`)

    if (textNodes.length === 0) {
        console.log('[LLM翻译] 没有找到需要翻译的文本')
        return
    }

    // 分离缓存和未缓存
    const uncachedNodes: TextNode[] = []

    textNodes.forEach(nodeInfo => {
        if (cache[nodeInfo.originalText]) {
            nodeInfo.node.textContent = cache[nodeInfo.originalText]
        } else {
            uncachedNodes.push(nodeInfo)
        }
    })

    const cachedCount = textNodes.length - uncachedNodes.length
    console.log(`[LLM翻译] 缓存命中 ${cachedCount}，需翻译 ${uncachedNodes.length}`)

    if (uncachedNodes.length === 0) {
        showNotification('✓ 从缓存加载完成！', 'success')
        return
    }

    // 分批参数 - 小批次 + 高并发 = 流畅的渐进式加载
    const batchSize = 12  // 小批次，更频繁更新
    const concurrency = config.concurrency || 3  // 使用配置的并发数
    let completed = cachedCount

    // 将所有节点分成批次
    const batches: TextNode[][] = []
    for (let i = 0; i < uncachedNodes.length; i += batchSize) {
        batches.push(uncachedNodes.slice(i, i + batchSize))
    }

    console.log(`[LLM翻译] 共 ${batches.length} 个批次，并发数 ${concurrency}`)

    // 翻译单个批次的函数
    const translateBatch = async (batch: TextNode[]): Promise<void> => {
        const texts = batch.map(n => n.originalText)
        try {
            const translations = await translateTexts(texts, config)
            batch.forEach((nodeInfo, idx) => {
                if (translations[idx] && translations[idx] !== nodeInfo.originalText) {
                    nodeInfo.node.textContent = translations[idx]
                    cache[nodeInfo.originalText] = translations[idx]
                }
            })
            completed += batch.length
            showNotification(`翻译中... ${completed}/${textNodes.length}`, 'info')
        } catch (error) {
            console.error('[LLM翻译] 批次翻译失败:', error)
            completed += batch.length // 即使失败也计数，避免进度卡住
        }
    }

    // 并发执行：每次同时处理 concurrency 个批次
    for (let i = 0; i < batches.length; i += concurrency) {
        const concurrentBatches = batches.slice(i, i + concurrency)
        // 同时发起多个请求
        await Promise.allSettled(concurrentBatches.map(batch => translateBatch(batch)))

        // 批次组之间短暂延迟，避免触发速率限制
        if (i + concurrency < batches.length) {
            await delay(100)
        }
    }

    showNotification('✓ 翻译完成！', 'success')
}

/**
 * 收集文本节点 - 优化版
 * 1. 更智能的过滤，减少不必要的翻译
 * 2. 放宽某些限制，避免漏翻
 */
function collectTextNodes(root: Element, doc: Document): TextNode[] {
    const textNodes: TextNode[] = []
    const seenTexts = new Set<string>()

    const excludeTags = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG',
        'INPUT', 'TEXTAREA', 'SELECT', 'CANVAS', 'VIDEO', 'AUDIO',
        'IMG', 'BR', 'HR' // 新增：这些标签中的文本不需要翻译
    ])

    // 判断是否为不需要翻译的模式（日期、版本号、纯符号、代码特征等）
    const isSkippable = (text: string): boolean => {
        // 纯符号/数字/空白
        if (/^[\d\s\p{P}\p{S}]*$/u.test(text)) return true
        // URL
        if (/^https?:\/\//.test(text)) return true
        // 日期格式
        if (/^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}$/.test(text)) return true
        if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s*\d{4}$/i.test(text)) return true
        // 版本号
        if (/^v?\d+(\.\d+)+$/i.test(text)) return true
        // 纯数字
        if (/^\d+$/.test(text)) return true
        // 没有至少一个英文字母
        if (!/[a-zA-Z]/.test(text)) return true

        // === 新增：强力代码特征过滤 ===
        const trimmed = text.trim()

        // 1. 点号/冒号分隔符 (如 torch.nn, std::vector, obj.prop)
        // 排除句号结尾的普通句子 (需中间有分隔符)
        if (/^[a-zA-Z0-9_]+(\.|::)[a-zA-Z0-9_]+([.:][a-zA-Z0-9_]+)*$/.test(trimmed)) return true

        // 2. 驼峰命名 (camelCase)
        // 排除包含空格的普通文本
        if (!trimmed.includes(' ')) {
            // camelCase: 小写开头，包含大写 (如 someVar) - 这种情况在普通文本中极少见(除了iPhone等)，可以保留
            if (/^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(trimmed)) return true

            // 删除 PascalCase 过滤！
            // 因为 "Home", "About", "Contact" 等普通单词也是 PascalCase 格式
            // 我们不能仅凭首字母大写就认为是代码类名
        }

        // 3. 下划线命名 (snake_case/SCREAMING_SNAKE_CASE)
        // 必须包含下划线，且不含空格
        if (trimmed.includes('_') && !trimmed.includes(' ')) return true

        // 4. 函数调用形式 (func(), method(arg))
        if (/^[a-zA-Z0-9_.]+\(.*\)$/.test(trimmed)) return true

        // 5. 看起来像代码路径或命令
        if (trimmed.startsWith('/') || trimmed.startsWith('-')) return true

        return false
    }

    const walker = doc.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => {
                const parent = node.parentElement
                if (!parent) return NodeFilter.FILTER_REJECT
                if (excludeTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT
                // 只排除 <code> 和 <pre>，不再排除 .hljs 和 .highlight（它们可能误伤）
                if (parent.closest('code, pre')) return NodeFilter.FILTER_REJECT

                const text = node.textContent?.trim() || ''
                // 空文本跳过
                if (text.length === 0) return NodeFilter.FILTER_REJECT
                // 使用新的跳过逻辑
                if (isSkippable(text)) return NodeFilter.FILTER_REJECT

                // 可见性检查
                try {
                    const style = doc.defaultView?.getComputedStyle(parent)
                    if (style?.display === 'none' || style?.visibility === 'hidden') {
                        return NodeFilter.FILTER_REJECT
                    }
                } catch { }

                // 去重：只对长文本去重（>15字符），短文本允许重复
                if (text.length > 15 && seenTexts.has(text)) return NodeFilter.FILTER_REJECT
                seenTexts.add(text)

                return NodeFilter.FILTER_ACCEPT
            }
        }
    )

    let node: Text | null
    while ((node = walker.nextNode() as Text)) {
        textNodes.push({
            node,
            originalText: node.textContent?.trim() || ''
        })
    }

    return textNodes
}

/**
 * 批量翻译
 */
async function translateTexts(texts: string[], config: PluginConfig): Promise<string[]> {
    const apiKey = config.apiKeys[config.provider]
    const apiUrl = getAPIUrl(config.provider)
    const targetLang = LANG_NAMES[config.targetLanguage] || config.targetLanguage

    const prompt = texts.map((text, i) => `${i}: ${text}`).join('\n')

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            messages: [
                { role: 'system', content: `Translate into ${targetLang}. Format each line as "number: translation". Output only translations.` },
                { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            thinking: { type: 'disabled' },
        }),
    })

    if (!response.ok) throw new Error(`API 失败: ${response.status}`)

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''

    return texts.map((originalText, index) => {
        const match = content.match(new RegExp(`^${index}[：:\\s]+(.+)$`, 'm'))
        return match ? match[1].trim() : originalText
    })
}

const LANG_NAMES: Record<string, string> = {
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    'en': 'English',
    'ja': 'Japanese',
}

function getAPIUrl(provider: string): string {
    const urls: Record<string, string> = {
        deepseek: 'https://api.deepseek.com/chat/completions',
        qwen: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
        zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    }
    return urls[provider] || urls.deepseek
}

// 封装 sendMessage 以处理上下文失效错误
async function sendMessage(message: any): Promise<any> {
    return new Promise((resolve, reject) => {
        try {
            if (!chrome.runtime?.id) {
                throw new Error('Extension context invalidated')
            }
            chrome.runtime.sendMessage(message, (response) => {
                const error = chrome.runtime.lastError
                if (error) {
                    //这是最常见的上下文失效错误信息
                    if (error.message?.includes('Extension context invalidated')) {
                        showNotification('插件已更新，请刷新页面后重试', 'error')
                        // 移除悬浮球以防止再次误触
                        const fab = document.getElementById('llm-translate-fab')
                        if (fab) fab.remove()
                    }
                    reject(error)
                } else {
                    resolve(response)
                }
            })
        } catch (e: any) {
            if (e.message?.includes('Extension context invalidated')) {
                showNotification('插件已更新，请刷新页面后重试', 'error')
                const fab = document.getElementById('llm-translate-fab')
                if (fab) fab.remove()
            }
            reject(e)
        }
    })
}

async function getConfig(): Promise<PluginConfig> {
    try {
        // 优先从 storage 读取
        const storageData = await chrome.storage.local.get('pluginConfig')
        if (storageData.pluginConfig) {
            return { ...DEFAULT_CONFIG, ...storageData.pluginConfig }
        }

        // 备选：请求 background
        const response = await sendMessage({ type: MessageType.GET_CONFIG })
        return response || DEFAULT_CONFIG
    } catch (error) {
        console.warn('获取配置失败，使用默认配置:', error)
        return DEFAULT_CONFIG
    }
}

function restorePage() {
    if (splitContainer) {
        splitContainer.remove()
        splitContainer = null
        leftIframe = null
        rightIframe = null
        document.body.style.overflow = ''
        isSplitView = false
        hideNotification()
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function hideNotification() {
    if (notificationElement) {
        notificationElement.remove()
        notificationElement = null
    }
}

function showNotification(message: string, type: 'info' | 'success' | 'error' = 'info') {
    const colors = {
        info: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        success: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
        error: 'linear-gradient(135deg, #eb3349 0%, #f45c43 100%)'
    }

    if (!notificationElement) {
        notificationElement = document.createElement('div')
        notificationElement.id = 'llm-main-notification'
        notificationElement.style.cssText = `
      position: fixed; top: 10px; right: 20px;
      padding: 10px 20px; color: white; border-radius: 8px;
      font-size: 14px; font-family: -apple-system, sans-serif;
      z-index: 2147483647;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    `
        document.body.appendChild(notificationElement)
    }

    notificationElement.textContent = message
    notificationElement.style.background = colors[type]

    if (type === 'success' || type === 'error') {
        setTimeout(() => {
            if (notificationElement) {
                notificationElement.style.opacity = '0'
                notificationElement.style.transition = 'opacity 0.3s'
                setTimeout(hideNotification, 300)
            }
        }, type === 'error' ? 5000 : 3000)
    }
}

// ============ 浮动翻译按钮 ============

let floatingBtn: HTMLButtonElement | null = null
let isDragging = false
let dragStartX = 0
let dragStartY = 0
let btnStartX = 0
let btnStartY = 0

function createFloatingButton() {
    // 避免重复创建
    if (floatingBtn || document.getElementById('llm-translate-fab')) return

    floatingBtn = document.createElement('button')
    floatingBtn.id = 'llm-translate-fab'

    // 初始内容：一个优雅的 "译" 字，或者 "AI 译"
    // 使用衬线字体让它看起来更高级
    const iconContent = `
        <span style="font-family: 'Songti SC', 'SimSun', serif; font-size: 20px; font-weight: 700; margin-right: 2px;">译</span>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.9;">
            <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1-1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
        </svg>
    `
    floatingBtn.innerHTML = iconContent
    floatingBtn.title = '点击开始 AI 翻译'

    // 样式优化：毛玻璃 + 渐变 + 弥散阴影
    floatingBtn.style.cssText = `
        position: fixed;
        bottom: 100px;
        right: 20px;
        width: 52px;
        height: 52px;
        border-radius: 26px; /* 圆形/胶囊 */
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: linear-gradient(135deg, rgba(102, 126, 234, 0.9) 0%, rgba(118, 75, 162, 0.9) 100%);
        backdrop-filter: blur(8px);
        color: white;
        cursor: grab;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 8px 32px rgba(31, 38, 135, 0.25);
        transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        user-select: none;
        font-family: system-ui, -apple-system, sans-serif;
    `

    // 悬停效果
    floatingBtn.onmouseenter = () => {
        if (floatingBtn && !isDragging) {
            floatingBtn.style.transform = 'translateY(-2px) scale(1.05)'
            floatingBtn.style.boxShadow = '0 12px 40px rgba(102, 126, 234, 0.4)'
        }
    }
    floatingBtn.onmouseleave = () => {
        if (floatingBtn && !isDragging) {
            floatingBtn.style.transform = 'translateY(0) scale(1)'
            floatingBtn.style.boxShadow = '0 8px 32px rgba(31, 38, 135, 0.25)'
        }
    }

    // 拖拽功能 (逻辑保持不变)
    floatingBtn.onmousedown = (e: MouseEvent) => {
        if (!floatingBtn) return
        isDragging = false
        dragStartX = e.clientX
        dragStartY = e.clientY

        const rect = floatingBtn.getBoundingClientRect()
        btnStartX = rect.left
        btnStartY = rect.top

        floatingBtn.style.cursor = 'grabbing'
        floatingBtn.style.transform = 'scale(0.95)' // 按下反馈

        const onMouseMove = (moveEvent: MouseEvent) => {
            const dx = moveEvent.clientX - dragStartX
            const dy = moveEvent.clientY - dragStartY

            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
                isDragging = true
            }

            if (isDragging && floatingBtn) {
                let newX = btnStartX + dx
                let newY = btnStartY + dy
                const maxX = window.innerWidth - 56
                const maxY = window.innerHeight - 56
                newX = Math.max(0, Math.min(newX, maxX))
                newY = Math.max(0, Math.min(newY, maxY))

                floatingBtn.style.right = 'auto'
                floatingBtn.style.bottom = 'auto'
                floatingBtn.style.left = newX + 'px'
                floatingBtn.style.top = newY + 'px'
                floatingBtn.style.transition = 'none'
            }
        }

        const onMouseUp = () => {
            if (floatingBtn) {
                floatingBtn.style.cursor = 'grab'
                floatingBtn.style.transform = 'translateY(0) scale(1)'
                // 恢复 transition
                floatingBtn.style.transition = 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)'
            }
            document.removeEventListener('mousemove', onMouseMove)
            document.removeEventListener('mouseup', onMouseUp)

            if (!isDragging) {
                handleButtonClick()
            }
        }

        document.addEventListener('mousemove', onMouseMove)
        document.addEventListener('mouseup', onMouseUp)
        e.preventDefault()
    }

    // 禁用默认点击（由 mouseup 处理）
    floatingBtn.onclick = (e) => {
        e.preventDefault()
    }

    document.body.appendChild(floatingBtn)
    console.log('[LLM翻译] 浮动按钮已创建')
}

function handleButtonClick() {
    if (isSplitView || isInlineMode || isBilingualMode) {
        // 已经翻译过，点击退出
        if (isInlineMode) {
            restoreInlinePage()
        } else if (isBilingualMode) {
            restoreBilingualPage()
        } else {
            restorePage()
        }
        updateFloatingButtonState('idle')
    } else {
        // 根据保存的配置选择翻译模式
        getConfig().then(config => {
            if (config.translateMode === 'inline') {
                startInlineTranslation()
            } else if (config.translateMode === 'bilingual') {
                startBilingualTranslation()
            } else {
                startSplitTranslation()
            }
        })
    }
}

function updateFloatingButtonState(state: 'idle' | 'translating' | 'done') {
    if (!floatingBtn) return

    switch (state) {
        case 'translating':
            floatingBtn.style.background = 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)'
            floatingBtn.style.width = '52px'
            // 使用 SVG 内部动画 (SMIL)，无需依赖外部 CSS，兼容性最强
            floatingBtn.innerHTML = `
                <svg width="24" height="24" viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="25" cy="25" r="20" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-dasharray="80, 200">
                        <animateTransform 
                            attributeName="transform" 
                            attributeType="XML" 
                            type="rotate" 
                            from="0 25 25" 
                            to="360 25 25" 
                            dur="1s" 
                            repeatCount="indefinite" />
                    </circle>
                </svg>
            `
            floatingBtn.title = 'AI 正在思考...'
            break

        case 'done':
            // 变成长条形，显示 "还原"
            floatingBtn.style.background = 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)' // 清新的绿色
            floatingBtn.style.width = 'auto'
            floatingBtn.style.padding = '0 16px'
            floatingBtn.style.borderRadius = '26px'
            floatingBtn.innerHTML = `
                <span style="font-weight: 600; font-size: 14px; margin-right: 4px;">↺</span>
                <span style="font-weight: 500; font-size: 14px;">还原</span>
            `
            floatingBtn.title = '点击恢复原文'
            break

        default: // idle
            floatingBtn.style.background = 'linear-gradient(135deg, rgba(102, 126, 234, 0.95) 0%, rgba(118, 75, 162, 0.95) 100%)'
            floatingBtn.style.width = '52px'
            floatingBtn.style.height = '52px'
            floatingBtn.style.padding = '0'
            floatingBtn.style.borderRadius = '26px'
            // 恢复那个帅气的 "译 + 星星"
            floatingBtn.innerHTML = `
                <span style="font-family: 'Songti SC', 'SimSun', serif; font-size: 20px; font-weight: 700; margin-right: 2px;">译</span>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.9;">
                    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1-1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                </svg>
            `
            floatingBtn.title = '点击开始 AI 翻译'
    }
}

// 添加 CSS 动画
function injectStyles() {
    if (document.getElementById('llm-translate-styles')) return

    const style = document.createElement('style')
    style.id = 'llm-translate-styles'
    style.textContent = `
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }
    `
    document.head.appendChild(style)
}

// 页面加载完成后创建浮动按钮
function initFloatingButton() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            injectStyles()
            createFloatingButton()
        })
    } else {
        injectStyles()
        createFloatingButton()
    }
}

// 自动初始化
initFloatingButton()
