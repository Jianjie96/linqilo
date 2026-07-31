const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 初始化腾讯云 OCR 客户端
const tencentcloud = require('tencentcloud-sdk-nodejs-ocr')
const OcrClient = tencentcloud.ocr.v20181119.Client

let ocrClient = null

function getOcrClient() {
  if (ocrClient) return ocrClient

  const secretId = process.env.TENCENTCLOUD_SECRETID
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY

  if (!secretId || !secretKey) {
    throw new Error('缺少腾讯云密钥，请在云函数环境变量中配置 TENCENTCLOUD_SECRETID 和 TENCENTCLOUD_SECRETKEY')
  }

  ocrClient = new OcrClient({
    credential: { secretId, secretKey },
    region: 'ap-guangzhou',
    profile: {
      httpProfile: {
        endpoint: 'ocr.tencentcloudapi.com'
      }
    }
  })
  return ocrClient
}

// OCR 通用印刷体识别（腾讯云 OCR GeneralBasicOCR）
exports.main = async (event, context) => {
  const { fileID } = event

  if (!fileID) {
    return { success: false, error: '缺少 fileID 参数' }
  }

  try {
    // 从云存储下载图片
    const fileBuffer = await cloud.downloadFile({ fileID: fileID })

    // 调用腾讯云 OCR 通用印刷体识别
    const result = await recognizeByTencentOCR(fileBuffer.fileContent)

    return result
  } catch (err) {
    console.error('OCR 识别失败:', err)
    return {
      success: false,
      error: err.message || '识别失败'
    }
  }
}

// 使用腾讯云 OCR 通用印刷体识别（GeneralBasicOCR）
async function recognizeByTencentOCR(imgBuffer) {
  const client = getOcrClient()

  // 转为 base64（GeneralBasicOCR 要求不带 data:image 前缀）
  const base64 = imgBuffer.toString('base64')

  const result = await client.GeneralBasicOCR({
    ImageBase64: base64
  })

  // TextDetections 为识别结果数组，每项包含 DetectedText、Confidence 等
  const items = (result.TextDetections || []).map(item => ({
    text: item.DetectedText || '',
    confidence: item.Confidence || 0
  }))

  const fullText = items.map(item => item.text).join('\n')

  return {
    success: true,
    text: fullText,
    items: items
  }
}
