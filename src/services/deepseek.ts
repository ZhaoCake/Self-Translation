/**
 * DeepSeek 翻译服务提供商
 * 使用 DeepSeek Chat API 进行翻译
 */

import { TextChunk, TranslatedChunk, ErrorCode } from '../shared/types'
import {
    TranslationProvider,
    TranslateOptions,
    TranslateResult,
    createTranslationError,
    markAsTranslated,
    markAsFailed
} from '../shared/provider'

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'

/** DeepSeek API 请求体 */
interface DeepSeekRequest {
    model: string
    messages: Array<{
        role: 'system' | 'user' | 'assistant'
        content: string
    }>
    temperature?: number
    max_tokens?: number
    stream?: boolean
    thinking?: { type: 'enabled' | 'disabled' }
}

/** DeepSeek API 响应体 */
interface DeepSeekResponse {
    id: string
    object: string
    created: number
    model: string
    choices: Array<{
        index: number
        message: {
            role: string
            content: string
        }
        finish_reason: string
    }>
    usage: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
    }
}

/** DeepSeek 错误响应 */
interface DeepSeekError {
    error: {
        message: string
        type: string
        code: string
    }
}

export class DeepSeekProvider implements TranslationProvider {
    name = 'DeepSeek'

    /**
     * 翻译一批文本块
     */
    async translate(chunks: TextChunk[], options: TranslateOptions): Promise<TranslateResult> {
        if (chunks.length === 0) {
            return { success: true, chunks: [] }
        }

        try {
            // 构建翻译请求
            const textsToTranslate = chunks.map((chunk, index) =>
                `[${index}] ${chunk.text}`
            ).join('\n\n')

            const systemPrompt = this.buildSystemPrompt(options)
            const userPrompt = this.buildUserPrompt(textsToTranslate, chunks.length)

            const response = await this.callAPI(options.apiKey, systemPrompt, userPrompt, options.model)

            if (!response.ok) {
                const errorData = await response.json() as DeepSeekError
                return this.handleAPIError(errorData, chunks)
            }

            const data = await response.json() as DeepSeekResponse
            const translatedTexts = this.parseResponse(data, chunks.length)

            // 构建翻译结果
            const translatedChunks: TranslatedChunk[] = chunks.map((chunk, index) => {
                const translatedText = translatedTexts[index]
                if (translatedText) {
                    return markAsTranslated(chunk, translatedText)
                } else {
                    return markAsFailed(chunk)
                }
            })

            return {
                success: true,
                chunks: translatedChunks,
            }

        } catch (error) {
            console.error('[DeepSeek] 翻译失败:', error)
            return {
                success: false,
                chunks: chunks.map(chunk => markAsFailed(chunk)),
                error: createTranslationError(
                    ErrorCode.NETWORK_ERROR,
                    error instanceof Error ? error.message : '网络请求失败',
                    true
                ),
            }
        }
    }

    /**
     * 验证 API Key
     */
    async validateApiKey(apiKey: string): Promise<boolean> {
        try {
            const response = await this.callAPI(apiKey, 'You are a helpful assistant.', 'Hello', 'deepseek-chat')
            return response.ok
        } catch {
            return false
        }
    }

    /**
     * 调用 DeepSeek API
     */
    private async callAPI(apiKey: string, systemPrompt: string, userPrompt: string, model: string = 'deepseek-chat'): Promise<Response> {
        const request: DeepSeekRequest = {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
            stream: false,
            thinking: { type: 'disabled' },
        }

        return fetch(DEEPSEEK_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(request),
        })
    }

    /**
     * 构建系统提示词
     */
    private buildSystemPrompt(options: TranslateOptions): string {
        const LANG_NAMES: Record<string, string> = {
            'zh-CN': 'Simplified Chinese',
            'zh-TW': 'Traditional Chinese',
            'en': 'English',
            'ja': 'Japanese',
        }
        const targetLang = LANG_NAMES[options.targetLanguage] || options.targetLanguage

        return `You are a professional translator specializing in technical fields (programming, engineering, science). Your task is to translate the given text into ${targetLang}.

Follow these core translation rules:

1. **PRESERVE ENTITIES** (highest priority)
   - Keep code-like terms unchanged: dotted names (\`torch.nn\`), underscores (\`user_id\`), parentheses, hash symbols
   - Keep camelCase terms: \`tensorAttributes\`, \`XMLHttpRequest\`, \`iPhone\`
   - Keep all-caps constants/abbreviations: \`CUDA\`, \`HTTP\`, \`JSON\`
   - Keep file paths, URLs, version numbers

2. **TERMINOLOGY HANDLING**
   - General terms like "Database" → translate to standard ${targetLang} equivalent
   - Domain-specific terms with well-known translations (e.g., "Neural Network") → translate
   - Framework-specific concepts prone to ambiguity (e.g., "Tensor", "Embedding", "Middleware", "Layout", "Schema") → keep original, or use "translation(original)" format
   - When in doubt, keep the English term rather than force a translation

3. **STYLE**
   - Professional and concise, suitable for technical readers
   - NEVER translate code elements (e.g., \`padding\` stays as \`padding\`)

4. **FORMAT**
   - Keep the [number] prefix at the start of each line: [number] translated text
   - One translation per line
   - No additional explanations or notes`
    }

    /**
     * 构建用户提示词
     */
    private buildUserPrompt(texts: string, count: number): string {
        return `Translate the following ${count} texts:

${texts}`
    }

    /**
     * 解析 API 响应
     */
    private parseResponse(data: DeepSeekResponse, expectedCount: number): string[] {
        const content = data.choices[0]?.message?.content || ''
        const results: string[] = []

        // 解析 [index] 格式的翻译结果
        const lines = content.split('\n').filter(line => line.trim())

        for (let i = 0; i < expectedCount; i++) {
            const pattern = new RegExp(`\\[${i}\\]\\s*(.+)`, 's')

            // 查找匹配的行
            for (const line of lines) {
                const match = line.match(pattern)
                if (match) {
                    results[i] = match[1].trim()
                    break
                }
            }

            // 如果没找到，尝试按行顺序匹配
            if (!results[i] && lines[i]) {
                // 移除可能的序号前缀
                results[i] = lines[i].replace(/^\[\d+\]\s*/, '').trim()
            }
        }

        return results
    }

    /**
     * 处理 API 错误
     */
    private handleAPIError(errorData: DeepSeekError, chunks: TextChunk[]): TranslateResult {
        const errorMessage = errorData.error?.message || '未知错误'
        const errorCode = errorData.error?.code || ''

        let code = ErrorCode.UNKNOWN
        let retryable = false

        if (errorCode.includes('invalid_api_key') || errorCode.includes('authentication')) {
            code = ErrorCode.INVALID_API_KEY
        } else if (errorCode.includes('rate_limit')) {
            code = ErrorCode.RATE_LIMITED
            retryable = true
        } else if (errorCode.includes('timeout')) {
            code = ErrorCode.TIMEOUT
            retryable = true
        }

        return {
            success: false,
            chunks: chunks.map(chunk => markAsFailed(chunk)),
            error: createTranslationError(code, errorMessage, retryable),
        }
    }
}

// 导出单例
export const deepseekProvider = new DeepSeekProvider()
