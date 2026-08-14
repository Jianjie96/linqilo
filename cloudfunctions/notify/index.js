const cloud = require('wx-server-sdk')
const https = require('https')

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
 *   3. 在云函数环境变量中设置 WX_APPSECRET（小程序密钥）
 *   4. 用户已在小程序中点击「开启通知」完成订阅授权
 */

// ⚠️ 请替换为你在微信公众平台申请的订阅消息模板 ID
// 模板字段（需与微信公众平台模板一一对应）：
//   thing7  - 物品名称
//   time6   - 过期日期
//   thing3  - 备注
const TEMPLATE_ID = '68FxhLOgJgDwUZWFOZFunglKqFWCsHPq3vSwsKI9YPY'

const APPID = 'wx742667049b5e316a'

// 默认提前提醒天数
const DEFAULT_ALERT_DAYS = 1

// ⚠️ 测试模式：true 时跳过物品查询，直接向所有已订阅用户发送测试通知
// 测试完成后请改回 false，并将 cron 时间改回 "0 0 8 * * * *"
const TEST_MODE = false

// --- access_token 缓存 ---
let cachedToken = null
let tokenExpireTime = 0

/**
 * 获取微信 access_token（带内存缓存，提前 5 分钟刷新）
 */
function getWxAccessToken() {
  return new Promise((resolve, reject) => {
    const now = Date.now()
    if (cachedToken && now < tokenExpireTime - 5 * 60 * 1000) {
      return resolve(cachedToken)
    }

    const APPSECRET = process.env.WX_APPSECRET
    if (!APPSECRET) {
      return reject(new Error('请在云函数环境变量中设置 WX_APPSECRET'))
    }

    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${APPSECRET}`

    https.get(url, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const result = JSON.parse(data)
          if (result.errcode && result.errcode !== 0) {
            reject(new Error(`获取 access_token 错误: ${result.errmsg} (errcode=${result.errcode})`))
            return
          }
          if (result.access_token) {
            cachedToken = result.access_token
            tokenExpireTime = now + (result.expires_in || 7200) * 1000
            console.log(`access_token 已刷新，有效期至 ${new Date(tokenExpireTime).toISOString()}`)
            resolve(cachedToken)
          } else {
            reject(new Error(`获取 access_token 返回数据异常: ${data}`))
          }
        } catch (e) {
          reject(new Error(`解析 access_token 响应失败: ${e.message}`))
        }
      })
    }).on('error', (err) => {
      reject(new Error(`请求 access_token 网络失败: ${err.message}`))
    })
  })
}

/**
 * 发送订阅消息（直接调用微信 REST API，不依赖 cloud.openapi）
 * 参数与 cloud.openapi.subscribeMessage.send() 保持一致
 */
function sendSubscribeMessage({ touser, templateId, page, data }) {
  return getWxAccessToken().then(accessToken => {
    const postData = JSON.stringify({
      touser,
      template_id: templateId,
      page: page || '',
      miniprogram_state: 'formal',
      data,
      lang: 'zh_CN'
    })

    const options = {
      hostname: 'api.weixin.qq.com',
      path: `/cgi-bin/message/subscribe/send?access_token=${accessToken}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          try {
            const result = JSON.parse(body)
            if (result.errcode === 0) {
              resolve(result)
            } else {
              const err = new Error(result.errmsg || '微信 API 调用失败')
              err.errCode = result.errcode
              reject(err)
            }
          } catch (e) {
            reject(new Error(`解析发送结果失败: ${e.message}`))
          }
        })
      })

      req.on('error', (err) => {
        reject(new Error(`发送订阅消息网络失败: ${err.message}`))
      })

      req.write(postData)
      req.end()
    })
  })
}

exports.main = async (event, context) => {
  if (TEST_MODE) {
    return await testNotify()
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = formatDate(today)

  try {
    // 1. 查询所有用户的绑定关系
    const usersRes = await db.collection('users').get()
    const users = usersRes.data || []

    // 没有 users 表记录的用户走默认个人视角
    // 构建每个用户需要检查的物品范围
    const userNotifyMap = {} // openid -> { items: [], boundType: 'personal' | 'team' }

    for (const user of users) {
      const openid = user.openid
      const boundGroupId = user.boundGroupId || null

      userNotifyMap[openid] = {
        boundGroupId,
        boundType: boundGroupId ? 'team' : 'personal',
        items: []
      }
    }

    // 2. 查询所有物品
    const [expiredRes, upcomingRes] = await Promise.all([
      db.collection('items').where({ expiryDate: _.lt(todayStr) }).limit(500).get(),
      db.collection('items').where({ expiryDate: _.gte(todayStr) }).limit(500).get()
    ])

    const allItems = [...(expiredRes.data || []), ...(upcomingRes.data || [])]

    // 3. 按绑定关系分发物品到对应用户
    // 个人物品：按 _openid 分发
    // 队伍物品：分发给绑定了该队伍的所有用户
    const teamBindings = {} // teamId -> [openid, ...]
    for (const user of users) {
      if (user.boundGroupId) {
        if (!teamBindings[user.boundGroupId]) {
          teamBindings[user.boundGroupId] = []
        }
        teamBindings[user.boundGroupId].push(user.openid)
      }
    }

    for (const item of allItems) {
      // 已省钱物品不再提醒
      if (item.saved) continue

      const daysRemaining = calcDaysRemaining(item.expiryDate)
      const alertDays = item.alertDays || DEFAULT_ALERT_DAYS

      // 判断是否在提醒范围内
      if (daysRemaining >= 0 && daysRemaining > alertDays) continue

      const itemWithDays = { ...item, daysRemaining }
      const groupId = item.groupId || null

      if (groupId) {
        // 队伍物品：通知绑定了该队伍的所有用户
        const openids = teamBindings[groupId] || []
        for (const openid of openids) {
          if (userNotifyMap[openid]) {
            userNotifyMap[openid].items.push(itemWithDays)
          }
        }
      } else {
        // 个人物品：只通知创建者（且绑定个人）
        const openid = item._openid || item.openid
        if (openid && userNotifyMap[openid] && userNotifyMap[openid].boundType === 'personal') {
          userNotifyMap[openid].items.push(itemWithDays)
        } else if (openid && !userNotifyMap[openid]) {
          // 用户没有 users 记录，默认个人视角
          userNotifyMap[openid] = {
            boundGroupId: null,
            boundType: 'personal',
            items: [itemWithDays]
          }
        }
      }
    }

    // 4. 查询已订阅的用户
    const openids = Object.keys(userNotifyMap).filter(id => userNotifyMap[id].items.length > 0)
    if (openids.length === 0) {
      return { success: true, sent: 0, message: '没有需要通知的用户' }
    }

    const subsRes = await db.collection('subscriptions').where({
      openid: _.in(openids),
      enabled: true
    }).get()

    const subscribedOpenids = new Set((subsRes.data || []).map(s => s.openid))

    // 5. 发送订阅消息
    let sentCount = 0
    const errors = []

    for (const openid of openids) {
      if (!subscribedOpenids.has(openid)) continue

      const userItems = userNotifyMap[openid].items
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
        await sendSubscribeMessage({
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
        await sendSubscribeMessage({
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
          errMsg: err.message,
          detail: err.message
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
