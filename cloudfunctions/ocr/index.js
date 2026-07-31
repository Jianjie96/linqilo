const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 尝试加载 @cloudbase/node-sdk（用于 AI 视觉模型，未安装则降级到微信 OCR）
let tcb = null
try {
  tcb = require('@cloudbase/node-sdk')
} catch (e) {
  console.warn('@cloudbase/node-sdk 未安装，将使用微信 OCR')
}

// 初始化 CloudBase Node SDK（用于 AI 模型调用）
let aiApp = null
if (tcb) {
  try {
    aiApp = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV })
  } catch (e) {
    console.warn('CloudBase Node SDK 初始化失败:', e.message)
  }
}

// OCR 通用印刷体识别
// 优先使用 CloudBase AI 视觉模型（glm-5v-turbo），避免 openapi.ocr.printedText 配额不足（errCode: 101003）
// AI 模型不可用时自动回退到微信 OCR
exports.main = async (event, context) => {
  const { fileID } = event

  if (!fileID) {
    return { success: false, error: '缺少 fileID 参数' }
  }

  try {
    // 从云存储下载图片
    const fileBuffer = await cloud.downloadFile({ fileID: fileID })

    // --- 方案一：CloudBase AI 视觉模型 ---
    if (aiApp) {
      try {
        const result = await recognizeByAI(fileBuffer.fileContent, fileID)
        return result
      } catch (aiErr) {
        console.warn('AI 视觉模型识别失败，回退到微信 OCR:', aiErr.message)
        // 继续执行回退方案
      }
    }

    // --- 方案二（回退）：微信 OCR printedText ---
    return await recognizeByWechatOCR(fileBuffer.fileContent)
  } catch (err) {
    console.error('OCR 识别失败:', err)
    return {
      success: false,
      error: err.errCode ? `${err.errCode}: ${err.errMsg}` : err.message || '识别失败'
    }
  }
}

// 使用 CloudBase AI 视觉模型提取文字
async function recognizeByAI(imgBuffer, fileID) {
  const ai = aiApp.ai()
  const model = ai.createModel('cloudbase')

  // 转为 base64 data URL（视觉模型要求图片以 data URL 格式传入）
  const base64 = imgBuffer.toString('base64')
  const ext = (fileID.match(/\.(jpg|jpeg|png|bmp)(\?|$)/i) || [, 'jpeg'])[1].toLowerCase()
  const dataUrl = `data:image/${ext};base64,${base64}`

  const result = await model.generateText({
    model: 'glm-5v-turbo',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '请识别并提取图片中的所有文字内容。只返回识别到的纯文字，保持原文换行格式，不要添加任何解释说明。' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  })

  const fullText = result.text || ''

  return {
    success: true,
    text: fullText,
    items: [{ text: fullText, confidence: 1 }]
  }
}

// 回退方案：微信 OCR printedText
async function recognizeByWechatOCR(imgBuffer) {
  const result = await cloud.openapi.ocr.printedText({
    img: imgBuffer
  })

  const items = (result.items || []).map(item => ({
    text: item.text,
    confidence: item.confidence || 0
  }))

  const fullText = items.map(item => item.text).join('\n')

  return {
    success: true,
    text: fullText,
    items: items
  }
}
