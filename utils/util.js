// 工具函数

/**
 * 格式化日期为 YYYY-MM-DD
 */
function formatDate(date) {
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 计算两个日期之间的天数差
 * @returns {number} 正数表示未到期，负数表示已过期
 */
function calcDaysRemaining(expiryDate) {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const expiry = new Date(expiryDate)
  expiry.setHours(0, 0, 0, 0)
  const diff = expiry.getTime() - now.getTime()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

/**
 * 获取物品状态
 * @param {string} expiryDate 到期日期
 * @param {number} alertDays 提前提醒天数
 * @returns {string} safe | warning | danger | expired
 */
function getItemStatus(expiryDate, alertDays = 1) {
  const days = calcDaysRemaining(expiryDate)
  if (days < 0) return 'expired'
  if (days === 0) return 'danger'
  if (days <= alertDays) return 'warning'
  return 'safe'
}

/**
 * 获取状态文字
 */
function getStatusText(status) {
  const map = {
    safe: '安全',
    warning: '临期',
    danger: '即将到期',
    expired: '已过期'
  }
  return map[status] || ''
}

/**
 * 获取倒计时显示文字
 */
function getCountdownText(expiryDate) {
  const days = calcDaysRemaining(expiryDate)
  if (days < 0) return `已过期 ${Math.abs(days)} 天`
  if (days === 0) return '今天到期'
  if (days === 1) return '明天到期'
  return `还剩 ${days} 天`
}

/**
 * 获取相对时间文字
 */
function getRelativeTime(dateStr) {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 30) return `${days} 天前`
  return formatDate(dateStr)
}

/**
 * 从文本中解析日期（支持多种格式）
 */
function parseDateFromText(text) {
  if (!text) return null

  // 去除空格
  text = text.replace(/\s+/g, '')

  // 匹配 YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
  let match = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (match) {
    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  }

  // 匹配 YYYYMMDD (8位数字)
  match = text.match(/(\d{4})(\d{2})(\d{2})/)
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`
  }

  // 匹配 MM-DD, MM/DD (假设当年)
  match = text.match(/(\d{1,2})[-/.](\d{1,2})/)
  if (match) {
    const year = new Date().getFullYear()
    return `${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`
  }

  return null
}

/**
 * 从 OCR 文本中提取生产日期和保质期信息
 */
function extractDateInfo(text) {
  const result = {
    productionDate: null,
    expiryDate: null,
    shelfLife: null,
    itemName: null
  }

  if (!text) return result

  const lines = text.split('\n')

  for (const line of lines) {
    const lowerLine = line.toLowerCase()

    // 查找生产日期
    if (lowerLine.includes('生产日期') || lowerLine.includes('生产') || lowerLine.includes('产期')) {
      const date = parseDateFromText(line)
      if (date) result.productionDate = date
    }

    // 查找到期日期
    if (lowerLine.includes('到期') || lowerLine.includes('过期') || lowerLine.includes('失效') || lowerLine.includes('有效期至')) {
      const date = parseDateFromText(line)
      if (date) result.expiryDate = date
    }

    // 查找保质期（天数）
    if (lowerLine.includes('保质期') || lowerLine.includes('有效期')) {
      const match = line.match(/(\d+)\s*[天日]/)
      if (match) {
        result.shelfLife = parseInt(match[1])
      }
      // 月
      const monthMatch = line.match(/(\d+)\s*个?月/)
      if (monthMatch) {
        result.shelfLife = parseInt(monthMatch[1]) * 30
      }
      // 年
      const yearMatch = line.match(/(\d+)\s*年/)
      if (yearMatch) {
        result.shelfLife = parseInt(yearMatch[1]) * 365
      }
    }
  }

  // 如果有生产日期和保质期，计算到期日期
  if (result.productionDate && result.shelfLife && !result.expiryDate) {
    const prodDate = new Date(result.productionDate)
    prodDate.setDate(prodDate.getDate() + result.shelfLife)
    result.expiryDate = formatDate(prodDate)
  }

  return result
}

/**
 * 根据保质期天数，从生产日期计算到期日期
 */
function calcExpiryFromShelfLife(productionDate, shelfLifeDays) {
  const date = new Date(productionDate)
  date.setDate(date.getDate() + shelfLifeDays)
  return formatDate(date)
}

/**
 * 根据物品列表排序（按到期日期升序）
 */
function sortItemsByExpiry(items) {
  return [...items].sort((a, b) => {
    const dateA = new Date(a.expiryDate)
    const dateB = new Date(b.expiryDate)
    return dateA.getTime() - dateB.getTime()
  })
}

module.exports = {
  formatDate,
  calcDaysRemaining,
  getItemStatus,
  getStatusText,
  getCountdownText,
  getRelativeTime,
  parseDateFromText,
  extractDateInfo,
  calcExpiryFromShelfLife,
  sortItemsByExpiry
}
