const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// OCR 通用印刷体识别
exports.main = async (event, context) => {
  const { fileID } = event

  if (!fileID) {
    return { success: false, error: '缺少 fileID 参数' }
  }

  try {
    // 从云存储下载图片
    const fileBuffer = await cloud.downloadFile({
      fileID: fileID
    })

    // 调用微信 OCR 服务 - 通用印刷体识别（使用 img Buffer 而非 imgUrl）
    const result = await cloud.openapi.ocr.printedText({
      img: fileBuffer.fileContent
    })

    // 提取识别文本
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
  } catch (err) {
    console.error('OCR 识别失败:', err)
    return {
      success: false,
      error: err.errCode ? `${err.errCode}: ${err.errMsg}` : err.message || '识别失败'
    }
  }
}
