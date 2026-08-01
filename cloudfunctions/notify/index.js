const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

/**
 * 临期提醒云函数
 * 
 * 功能：
 *   1. 定时触发（每天早上 8:00）
 *   2. 查询所有用户的临期物品
 *   3. 给已订阅的用户发送微信订阅消息
 * 
 * 使用前提：
 *   1. 在微信公众平台「订阅消息」中选用模板并获取 templateId
 *   2. 将 templateId 填入下方 TEMPLATE_ID 常量
 *   3. 用户已在小程序中点击「开启通知」完成订阅授权
 */

// ⚠️ 请替换为你在微信公众平台申请的订阅消息模板 ID
// 模板字段（需与微信公众平台模板一一对应）：
//   thing7  - 物品名称
//   time6   - 过期日期
//   thing3  - 备注
const TEMPLATE_ID = '68FxhLOgJgDwUZWFOZFunglKqFWCsHPq3vSwsKI9YPY'

// 默认提前提醒天数
const DEFAULT_ALERT_DAYS = 1

// ⚠️ 测试模式：true 时跳过物品查询，直接向所有已订阅用户发送测试通知
// 测试完成后请改回 false，并将 cron 时间改回 "0 0 8 * * * *"
const TEST_MODE = true

exports.main = async (event, context) => {
  if (TEST_MODE) {
    return await testNotify()
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // 计算提醒日期范围：今天 ~ 今天+N天 内到期的物品
  const maxAlertDays = 30 // 最大提前提醒天数
  const futureDate = new Date(today)
  futureDate.setDate(futureDate.getDate() + maxAlertDays)

  const todayStr = formatDate(today)
  const futureStr = formatDate(futureDate)

  try {
    // 1. 查询所有临期物品（到期日在今天到未来30天之间）
    const itemsRes = await db.collection('items').where({
      expiryDate: _.gte(todayStr).and(_.lte(futureStr))
    }).limit(500).get()

    const items = itemsRes.data || []

    if (items.length === 0) {
      return { success: true, sent: 0, message: '没有临期物品' }
    }

    // 2. 按用户 openid 分组
    const userItemsMap = {}
    for (const item of items) {
      const openid = item._openid || item.openid
      if (!openid) continue

      const alertDays = item.alertDays || DEFAULT_ALERT_DAYS
      const daysRemaining = calcDaysRemaining(item.expiryDate)

      // 判断是否在提醒范围内（已过期 或 在 alertDays 天内到期）
      if (daysRemaining < 0 || daysRemaining <= alertDays) {
        if (!userItemsMap[openid]) {
          userItemsMap[openid] = []
        }
        userItemsMap[openid].push({
          ...item,
          daysRemaining
        })
      }
    }

    // 3. 查询已订阅的用户
    const openids = Object.keys(userItemsMap)
    if (openids.length === 0) {
      return { success: true, sent: 0, message: '没有需要通知的用户' }
    }

    const subsRes = await db.collection('subscriptions').where({
      openid: _.in(openids),
      enabled: true
    }).get()

    const subscribedOpenids = new Set((subsRes.data || []).map(s => s.openid))

    // 4. 发送订阅消息
    let sentCount = 0
    const errors = []

    for (const openid of openids) {
      if (!subscribedOpenids.has(openid)) continue

      const userItems = userItemsMap[openid]
      if (!userItems || userItems.length === 0) continue

      // 按到期日期排序，取最紧急的物品
      userItems.sort((a, b) => a.daysRemaining - b.daysRemaining)
      const mostUrgent = userItems[0]

      // 构建提醒内容
      let reminderText = ''
      if (userItems.length === 1) {
        reminderText = mostUrgent.daysRemaining < 0
          ? `已过期${Math.abs(mostUrgent.daysRemaining)}天`
          : mostUrgent.daysRemaining === 0
            ? '今天到期'
            : `还有${mostUrgent.daysRemaining}天到期`
      } else {
        const expiredCount = userItems.filter(i => i.daysRemaining < 0).length
        const todayCount = userItems.filter(i => i.daysRemaining === 0).length
        const upcomingCount = userItems.filter(i => i.daysRemaining > 0).length
        const parts = []
        if (expiredCount) parts.push(`${expiredCount}件已过期`)
        if (todayCount) parts.push(`${todayCount}件今天到期`)
        if (upcomingCount) parts.push(`${upcomingCount}件即将到期`)
        reminderText = parts.join('，') + '，请及时处理'
      }

      try {
        await cloud.openapi.subscribeMessage.send({
          touser: openid,
          templateId: TEMPLATE_ID,
          page: '/pages/index/index',
          data: {
            thing7: { value: mostUrgent.name.substring(0, 20) },
            time6: { value: mostUrgent.expiryDate },
            thing3: { value: reminderText.substring(0, 20) }
          }
        })
        sentCount++
      } catch (err) {
        errors.push({ openid, error: err.errCode || err.message })
        // 43101 = 用户拒绝接收，忽略
        if (err.errCode === 43101) continue
      }
    }

    return {
      success: true,
      sent: sentCount,
      total: openids.length,
      subscribed: subscribedOpenids.size,
      errors: errors.length > 0 ? errors : undefined,
      message: `发送 ${sentCount} 条通知`
    }
  } catch (err) {
    console.error('通知云函数执行失败:', err)
    return {
      success: false,
      error: err.message
    }
  }
}

// --- 测试模式（TEST_MODE=true 时执行） ---

async function testNotify() {
  const todayStr = formatDate(new Date())

  try {
    // 查询所有已订阅用户
    const subsRes = await db.collection('subscriptions').where({
      enabled: true
    }).get()

    const subscribedUsers = subsRes.data || []
    if (subscribedUsers.length === 0) {
      return {
        success: false,
        sent: 0,
        message: '没有订阅用户，请先在小程序设置页点击「开启通知」'
      }
    }

    let sentCount = 0
    const errors = []

    for (const sub of subscribedUsers) {
      try {
        await cloud.openapi.subscribeMessage.send({
          touser: sub.openid,
          templateId: TEMPLATE_ID,
          page: '/pages/index/index',
          data: {
            thing7: { value: '测试通知' },
            time6: { value: todayStr },
            thing3: { value: '这是一条测试消息，验证通知是否正常发送' }
          }
        })
        sentCount++
      } catch (err) {
        console.error(`发送失败 openid=${sub.openid}`, JSON.stringify({
          errCode: err.errCode,
          errMsg: err.errMsg || err.message,
          detail: err
        }))
        errors.push({ openid: sub.openid, error: err.errCode || err.message })
      }
    }

    return {
      success: sentCount > 0,
      sent: sentCount,
      total: subscribedUsers.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `测试模式：发送 ${sentCount} 条通知（共 ${subscribedUsers.length} 个订阅用户）`
    }
  } catch (err) {
    console.error('测试通知发送失败:', err)
    return {
      success: false,
      error: err.message
    }
  }
}

// --- 工具函数 ---

function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function calcDaysRemaining(expiryDate) {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const expiry = new Date(expiryDate)
  expiry.setHours(0, 0, 0, 0)
  return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}
