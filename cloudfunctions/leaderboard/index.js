// 排行榜 / 成就系统云函数
// action: recordAdd | recordSave | recordExpired | getStats
//
// user_stats 集合结构：
// {
//   _openid: string,
//   totalTracked: number,   // 累计追踪物品数
//   totalSaved: number,     // 避免过期的物品数（删除时未过期）
//   totalSavedValue: number, // 避免过期的物品总价值（真实省钱金额）
//   totalExpired: number,   // 已过期的物品数（删除时已过期）
//   updatedAt: string
// }

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTION = 'user_stats'

exports.main = async (event, context) => {
  const { action } = event
  const openid = cloud.getWXContext().OPENID

  try {
    switch (action) {
      case 'recordAdd':
        return await recordAdd(openid)
      case 'recordSave':
        return await recordSave(openid, event.value)
      case 'recordExpired':
        return await recordExpired(openid)
      case 'getStats':
        return await getStats(openid)
      default:
        return { code: -1, msg: '未知操作: ' + action }
    }
  } catch (err) {
    console.error(`[leaderboard:${action}] 失败:`, err)
    return { code: -1, msg: err.message }
  }
}

// 获取或创建用户统计记录
async function getOrCreateStats(openid) {
  const res = await db.collection(COLLECTION).where({ _openid: openid }).get()
  if (res.data.length > 0) {
    return res.data[0]
  }

  const newRecord = {
    _openid: openid,
    totalTracked: 0,
    totalSaved: 0,
    totalSavedValue: 0,
    totalExpired: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  const addRes = await db.collection(COLLECTION).add({ data: newRecord })
  return { _id: addRes._id, ...newRecord }
}

// 记录添加物品
async function recordAdd(openid) {
  const stats = await getOrCreateStats(openid)
  await db.collection(COLLECTION).doc(stats._id).update({
    data: {
      totalTracked: db.command.inc(1),
      updatedAt: new Date().toISOString()
    }
  })
  return { code: 0 }
}

// 记录避免过期（删除时物品未过期 / 标记已省钱），value 为物品价值
async function recordSave(openid, value) {
  const stats = await getOrCreateStats(openid)
  await db.collection(COLLECTION).doc(stats._id).update({
    data: {
      totalSaved: db.command.inc(1),
      totalSavedValue: db.command.inc(parseFloat(value) || 0),
      updatedAt: new Date().toISOString()
    }
  })
  return { code: 0 }
}

// 记录已过期（删除时物品已过期）
async function recordExpired(openid) {
  const stats = await getOrCreateStats(openid)
  await db.collection(COLLECTION).doc(stats._id).update({
    data: {
      totalExpired: db.command.inc(1),
      updatedAt: new Date().toISOString()
    }
  })
  return { code: 0 }
}

// 获取用户统计 + 全局百分位排名
async function getStats(openid) {
  const stats = await getOrCreateStats(openid)

  // 查询所有用户的统计，计算百分位
  const allUsers = await db.collection(COLLECTION).get()
  const totalUsers = allUsers.data.length

  let percentile = 0
  if (totalUsers > 0) {
    const usersBelow = allUsers.data.filter(u => (u.totalSaved || 0) < stats.totalSaved).length
    percentile = Math.round((usersBelow / totalUsers) * 100)
  }

  // 计算用户排名
  const sorted = allUsers.data.sort((a, b) => (b.totalSaved || 0) - (a.totalSaved || 0))
  const rank = sorted.findIndex(u => u._openid === openid) + 1

  return {
    code: 0,
    data: {
      totalTracked: stats.totalTracked || 0,
      totalSaved: stats.totalSaved || 0,
      totalSavedValue: stats.totalSavedValue || 0,
      totalExpired: stats.totalExpired || 0,
      percentile,
      rank,
      totalUsers
    }
  }
}
