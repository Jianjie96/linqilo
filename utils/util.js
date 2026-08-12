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

  // 匹配中文日期：YYYY年MM月DD日 / YYYY年MM月DD
  let match = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/)
  if (match) {
    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  }

  // 匹配 YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
  match = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
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
 * 验证日期字符串是否为有效日期（防止 2月30日 等非法日期通过）
 */
function isValidDate(dateStr) {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return false
  const [y, m, day] = dateStr.split('-').map(Number)
  return d.getFullYear() === y && d.getMonth() + 1 === m && d.getDate() === day
}

/**
 * 从文本中提取所有有效日期（不限关键字，纯靠日期格式识别）
 */
function extractAllDates(text) {
  const dates = []
  const seen = new Set()

  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  const p1 = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g
  let match
  while ((match = p1.exec(text)) !== null) {
    const y = parseInt(match[1])
    const m = parseInt(match[2])
    const d = parseInt(match[3])
    const dateStr = `${match[1]}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    if (y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31 && !seen.has(dateStr)) {
      if (isValidDate(dateStr)) {
        seen.add(dateStr)
        dates.push(dateStr)
      }
    }
  }

  // YYYY年MM月DD日 / YYYY年MM月DD（中文日期）
  const pChinese = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g
  while ((match = pChinese.exec(text)) !== null) {
    const y = parseInt(match[1])
    const m = parseInt(match[2])
    const d = parseInt(match[3])
    const dateStr = `${match[1]}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    if (y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31 && !seen.has(dateStr)) {
      if (isValidDate(dateStr)) {
        seen.add(dateStr)
        dates.push(dateStr)
      }
    }
  }

  // YYYYMMDD（8位连续数字，必须以20开头，前后非数字）
  const p2 = /(?:^|[^\d])(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[^\d]|$)/g
  while ((match = p2.exec(text)) !== null) {
    const dateStr = `${match[1]}-${match[2]}-${match[3]}`
    if (!seen.has(dateStr) && isValidDate(dateStr)) {
      seen.add(dateStr)
      dates.push(dateStr)
    }
  }

  // YYMMDD（6位紧凑日期，如 "251111" = 2025-11-11，前后非数字）
  const p6 = /(?:^|[^\d])(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[^\d]|$)/g
  while ((match = p6.exec(text)) !== null) {
    const yy = parseInt(match[1])
    const fullYear = yy >= 50 ? 1900 + yy : 2000 + yy
    const dateStr = `${fullYear}-${match[2]}-${match[3]}`
    if (!seen.has(dateStr) && isValidDate(dateStr)) {
      seen.add(dateStr)
      dates.push(dateStr)
    }
  }

  return dates
}

/**
 * 从文本中提取保质期天数（自动排除日期中的年月干扰）
 */
function extractShelfLife(text) {
  // 先移除日期模式，避免把 "2024年3月" 误识别为保质期
  const cleaned = text
    .replace(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}[日号]?/g, '')
    .replace(/\d{8}/g, '')

  // "365天", "90日"
  const dayMatch = cleaned.match(/(\d{1,4})\s*[天日](?!期)/)
  if (dayMatch) {
    const days = parseInt(dayMatch[1])
    if (days >= 1 && days <= 3650) return days
  }

  // "12个月", "18个月"
  const monthMatch = cleaned.match(/(\d{1,3})\s*个?月/)
  if (monthMatch) {
    const months = parseInt(monthMatch[1])
    if (months >= 1 && months <= 120) return months * 30
  }

  // "2年", "3年"
  const yearMatch = cleaned.match(/(\d)\s*年/)
  if (yearMatch) {
    const years = parseInt(yearMatch[1])
    if (years >= 1 && years <= 10) return years * 365
  }

  return null
}

/**
 * 从 OCR 文本中提取生产日期、保质期、过期日期
 *
 * 策略：
 *   1. 先尝试通过关键字标签匹配（生产日期、到期、保质期等）
 *   2. 标签不够时，提取所有日期并智能推断：
 *      - 两个日期 → 早的是生产日期，晚的是过期日期
 *      - 一个日期 → 过去的是生产日期，未来的是过期日期
 *   3. 最后交叉计算缺失字段：
 *      - 生产日期 + 保质期 → 过期日期
 *      - 过期日期 + 保质期 → 生产日期
 *      - 生产日期 + 过期日期 → 保质期
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
  const now = new Date()
  now.setHours(0, 0, 0, 0)

  // --- Step 1: 标签匹配（最高优先级） ---
  for (const line of lines) {
    const lowerLine = line.toLowerCase()

    // 生产日期标签
    if (!result.productionDate && /生产|产期|mfg|manufacture|制造|灌装|出厂/.test(lowerLine)) {
      const date = parseDateFromText(line)
      if (date) result.productionDate = date
    }

    // 过期日期标签
    if (!result.expiryDate && /到期|过期|失效|exp|expiry|best\s*before|use\s*by|限用|截止/.test(lowerLine)) {
      const date = parseDateFromText(line)
      if (date) result.expiryDate = date
    }

    // 保质期
    if (!result.shelfLife) {
      const sl = extractShelfLife(line)
      if (sl) result.shelfLife = sl
    }
  }

  // --- Step 2: 智能推断缺失字段 ---
  const allDates = extractAllDates(text)
  const usedDates = new Set([result.productionDate, result.expiryDate].filter(Boolean))
  const unusedDates = allDates.filter(d => !usedDates.has(d))

  if (unusedDates.length > 0) {
    if (!result.productionDate && !result.expiryDate) {
      // 两个都没找到，用日期值推断
      if (unusedDates.length >= 2) {
        // 多个日期：最早的 = 生产日期，最晚的 = 过期日期
        const sorted = [...unusedDates].sort((a, b) => new Date(a) - new Date(b))
        result.productionDate = sorted[0]
        result.expiryDate = sorted[sorted.length - 1]
      } else {
        // 单个日期：过去 = 生产日期，未来 = 过期日期
        const d = new Date(unusedDates[0])
        if (d <= now) {
          result.productionDate = unusedDates[0]
        } else {
          result.expiryDate = unusedDates[0]
        }
      }
    } else if (!result.productionDate) {
      // 有过期日期，缺生产日期 → 找过去的日期
      for (const d of unusedDates) {
        if (new Date(d) <= now) {
          result.productionDate = d
          break
        }
      }
      if (!result.productionDate && unusedDates.length > 0) {
        const sorted = unusedDates.sort((a, b) => new Date(a) - new Date(b))
        result.productionDate = sorted[0]
      }
    } else if (!result.expiryDate) {
      // 有生产日期，缺过期日期 → 找未来的日期
      for (const d of unusedDates) {
        if (new Date(d) > now) {
          result.expiryDate = d
          break
        }
      }
      if (!result.expiryDate && unusedDates.length > 0) {
        const sorted = unusedDates.sort((a, b) => new Date(a) - new Date(b))
        result.expiryDate = sorted[sorted.length - 1]
      }
    }
  }

  // --- Step 3: 交叉计算缺失字段 ---
  if (result.productionDate && result.shelfLife && !result.expiryDate) {
    const prod = new Date(result.productionDate)
    prod.setDate(prod.getDate() + result.shelfLife)
    result.expiryDate = formatDate(prod)
  }

  if (result.expiryDate && result.shelfLife && !result.productionDate) {
    const exp = new Date(result.expiryDate)
    exp.setDate(exp.getDate() - result.shelfLife)
    result.productionDate = formatDate(exp)
  }

  if (result.productionDate && result.expiryDate && !result.shelfLife) {
    const prod = new Date(result.productionDate)
    const exp = new Date(result.expiryDate)
    result.shelfLife = Math.round((exp - prod) / (1000 * 60 * 60 * 24))
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

/**
 * 根据创建时间排序（最新创建在前），同创建时间按到期日期升序
 */
function sortItemsByCreatedAt(items) {
  return [...items].sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0
    if (timeB !== timeA) return timeB - timeA
    return new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime()
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
  isValidDate,
  extractAllDates,
  extractShelfLife,
  extractDateInfo,
  calcExpiryFromShelfLife,
  sortItemsByExpiry,
  sortItemsByCreatedAt
}
