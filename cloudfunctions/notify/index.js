const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

/**
 * 临期提醒云函数
 * 
 * 功能：
 *   1. 定时触发（每天早上 8:00）：查询所有用户的临期物品并推送
 *   2. 事件触发（由 teams / items 云函数调用）：
 *      - action='memberJoined'：有人加入队伍，全队成员（含本人）收到入队通知
 *      - action='itemAdded'：队伍内新增物品，全队成员收到提醒（复用临期模板）
 * 
 * 推送范围（订阅集合模型）：
 *   用户的订阅目标 = 个人空间 + 已加入的所有队伍，减去手动静音（users.mutedGroups）的目标；
 *   一条推送汇总所有订阅目标的临期数据（个人与队伍分别统计件数）。
 *   注意：静音仅作用于每日临期推送，入队/新增物品等事件通知发给全部成员。
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

// 队伍事件模板（新成员加入）：
//   thing1  - 昵称
//   thing2  - 群组名
//   thing3  - 备注
const TEAM_EVENT_TEMPLATE_ID = 'poU7jsRy7SMjpdLCIqby5w-CLcaiSigGLdovQZFjCJc'

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

  // 事件触发（由 teams / items 云函数 callFunction 调用）
  if (event.action === 'memberJoined') {
    return await notifyMemberJoined(event)
  }
  if (event.action === 'itemAdded') {
    return await notifyItemAdded(event)
  }

  try {
    // 1. 拉取用户静音配置、成员关系、队伍名称与全部物品
    const [users, members, teams, items] = await Promise.all([
      fetchAll('users'),
      fetchAll('teamMembers'),
      fetchAll('teams'),
      fetchAll('items')
    ])

    const mutedMap = {} // openid -> Set(静音目标)
    for (const user of users) {
      const muted = Array.isArray(user.mutedGroups) ? user.mutedGroups : []
      mutedMap[user.openid] = new Set(muted)
    }

    const teamMemberMap = {} // teamId -> Set(openid)
    for (const m of members) {
      if (!teamMemberMap[m.teamId]) teamMemberMap[m.teamId] = new Set()
      teamMemberMap[m.teamId].add(m.openid)
    }

    const teamNameMap = {} // teamId -> 队伍名
    for (const t of teams) {
      teamNameMap[t.teamId] = t.name
    }

    // 2. 按订阅集合分发临期物品：openid -> { all: [], bySource: { 目标 -> [物品] } }
    const notifyMap = {}
    const ensurePack = (openid) => {
      if (!notifyMap[openid]) notifyMap[openid] = { all: [], bySource: {} }
      return notifyMap[openid]
    }

    for (const item of items) {
      // 已省钱物品不再提醒
      if (item.saved) continue

      const daysRemaining = calcDaysRemaining(item.expiryDate)
      const alertDays = item.alertDays || DEFAULT_ALERT_DAYS

      // 判断是否在提醒范围内
      if (daysRemaining >= 0 && daysRemaining > alertDays) continue

      const itemWithDays = { ...item, daysRemaining }
      const groupId = item.groupId || null

      if (groupId) {
        // 队伍物品：推给订阅了该队伍的所有成员（成员且未静音该队伍）
        const memberSet = teamMemberMap[groupId]
        if (!memberSet) continue
        for (const openid of memberSet) {
          const mutedSet = mutedMap[openid]
          if (mutedSet && mutedSet.has(groupId)) continue
          const pack = ensurePack(openid)
          pack.all.push(itemWithDays)
          if (!pack.bySource[groupId]) pack.bySource[groupId] = []
          pack.bySource[groupId].push(itemWithDays)
        }
      } else {
        // 个人物品：推给创建者（未静音个人空间）
        const openid = item._openid || item.openid
        if (!openid) continue
        const mutedSet = mutedMap[openid]
        if (mutedSet && mutedSet.has('personal')) continue
        const pack = ensurePack(openid)
        pack.all.push(itemWithDays)
        if (!pack.bySource.personal) pack.bySource.personal = []
        pack.bySource.personal.push(itemWithDays)
      }
    }

    // 3. 查询已订阅的用户
    const openids = Object.keys(notifyMap).filter(id => notifyMap[id].all.length > 0)
    if (openids.length === 0) {
      return { success: true, sent: 0, message: '没有需要通知的用户' }
    }

    const subsRes = await db.collection('subscriptions').where({
      openid: _.in(openids),
      enabled: true
    }).get()

    const subscribedOpenids = new Set((subsRes.data || []).map(s => s.openid))

    // 4. 发送订阅消息（一条推送汇总所有订阅目标的临期数据）
    let sentCount = 0
    const errors = []

    for (const openid of openids) {
      if (!subscribedOpenids.has(openid)) continue

      const pack = notifyMap[openid]
      if (!pack.all || pack.all.length === 0) continue

      // 按到期日期排序，取最紧急的物品
      pack.all.sort((a, b) => a.daysRemaining - b.daysRemaining)
      const mostUrgent = pack.all[0]

      // 状态统计 + 来源汇总（个人/各队伍分别计件）
      const expiredCount = pack.all.filter(i => i.daysRemaining < 0).length
      const todayCount = pack.all.filter(i => i.daysRemaining === 0).length
      const upcomingCount = pack.all.length - expiredCount - todayCount

      const statusParts = []
      if (expiredCount) statusParts.push(`${expiredCount}件已过期`)
      if (todayCount) statusParts.push(`${todayCount}件今天到期`)
      if (upcomingCount) statusParts.push(`${upcomingCount}件即将到期`)

      const sourceParts = []
      for (const key of Object.keys(pack.bySource)) {
        const count = pack.bySource[key].length
        const label = key === 'personal' ? '个人' : (teamNameMap[key] || '队伍')
        sourceParts.push(`${label}${count}件`)
      }

      let reminderText = statusParts.join('，')
      if (sourceParts.length > 1) {
        reminderText += `（${sourceParts.join('、')}）`
      } else if (sourceParts.length === 1 && sourceParts[0] !== '个人1件') {
        reminderText += `（${sourceParts[0]}）`
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

// --- 事件通知：新成员加入队伍 ---
// event: { action: 'memberJoined', teamId, openid, nickName? }
// 全队成员（含加入者本人）各收到一条：xxx 加入了队伍
async function notifyMemberJoined(event) {
  const { teamId, openid } = event
  try {
    if (!teamId || !openid) {
      return { success: false, error: '缺少 teamId 或 openid' }
    }

    const [teamRes, membersRes] = await Promise.all([
      db.collection('teams').where({ teamId }).get(),
      db.collection('teamMembers').where({ teamId }).get()
    ])

    const team = (teamRes.data || [])[0]
    if (!team) return { success: false, error: '队伍不存在' }

    const memberOpenids = (membersRes.data || []).map(m => m.openid)
    if (memberOpenids.length === 0) return { success: true, sent: 0 }

    // 加入者昵称（未设置资料时兜底「新成员」）
    let nickName = event.nickName
    if (!nickName) {
      const userRes = await db.collection('users')
        .where({ openid })
        .field({ nickName: true })
        .get()
      nickName = (userRes.data && userRes.data[0] && userRes.data[0].nickName) || '新成员'
    }

    let sentCount = 0
    const errors = []

    for (const memberOpenid of memberOpenids) {
      const remark = memberOpenid === openid
        ? '加入成功，和队友一起记录临期物品吧'
        : '加入了队伍，欢迎新队友'
      try {
        await sendSubscribeMessage({
          touser: memberOpenid,
          templateId: TEAM_EVENT_TEMPLATE_ID,
          page: '/pages/team/team',
          data: {
            thing1: { value: nickName.substring(0, 20) },
            thing2: { value: team.name.substring(0, 20) },
            thing3: { value: remark.substring(0, 20) }
          }
        })
        sentCount++
      } catch (err) {
        // 43101 = 用户未订阅/拒收，静默跳过
        if (err.errCode !== 43101) {
          errors.push({ openid: memberOpenid, error: err.errCode || err.message })
        }
      }
    }

    return {
      success: true,
      sent: sentCount,
      total: memberOpenids.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `入队通知发送 ${sentCount}/${memberOpenids.length} 条`
    }
  } catch (err) {
    console.error('入队通知发送失败:', err)
    return { success: false, error: err.message }
  }
}

// --- 事件通知：队伍内新增物品 ---
// event: { action: 'itemAdded', teamId, openid, itemName, expiryDate }
// 全队成员各收到一条（复用临期模板），备注注明：xxx 在 xxx 添加了 xxx
async function notifyItemAdded(event) {
  const { teamId, openid, itemName, expiryDate } = event
  try {
    if (!teamId || !openid || !itemName) {
      return { success: false, error: '缺少 teamId / openid / itemName' }
    }

    const [teamRes, membersRes] = await Promise.all([
      db.collection('teams').where({ teamId }).get(),
      db.collection('teamMembers').where({ teamId }).get()
    ])

    const team = (teamRes.data || [])[0]
    if (!team) return { success: false, error: '队伍不存在' }

    const memberOpenids = (membersRes.data || []).map(m => m.openid)
    if (memberOpenids.length === 0) return { success: true, sent: 0 }

    // 添加者昵称（未设置资料时兜底「队友」）
    const userRes = await db.collection('users')
      .where({ openid })
      .field({ nickName: true })
      .get()
    const nickName = (userRes.data && userRes.data[0] && userRes.data[0].nickName) || '队友'

    const remark = `${nickName}在${team.name}添加了${itemName}`

    let sentCount = 0
    const errors = []

    for (const memberOpenid of memberOpenids) {
      try {
        await sendSubscribeMessage({
          touser: memberOpenid,
          templateId: TEMPLATE_ID,
          page: '/pages/index/index',
          data: {
            thing7: { value: itemName.substring(0, 20) },
            time6: { value: expiryDate || formatDate(new Date()) },
            thing3: { value: remark.substring(0, 20) }
          }
        })
        sentCount++
      } catch (err) {
        // 43101 = 用户未订阅/拒收，静默跳过
        if (err.errCode !== 43101) {
          errors.push({ openid: memberOpenid, error: err.errCode || err.message })
        }
      }
    }

    return {
      success: true,
      sent: sentCount,
      total: memberOpenids.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `新增物品通知发送 ${sentCount}/${memberOpenids.length} 条`
    }
  } catch (err) {
    console.error('新增物品通知发送失败:', err)
    return { success: false, error: err.message }
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

// 分页拉取集合全量数据（临期判断需要全量物品；用户/成员/队伍规模可控）
async function fetchAll(collection) {
  const pageSize = 1000
  let skip = 0
  const list = []
  while (true) {
    const res = await db.collection(collection).skip(skip).limit(pageSize).get()
    list.push(...(res.data || []))
    if ((res.data || []).length < pageSize) break
    skip += pageSize
  }
  return list
}

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
