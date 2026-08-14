// 排行榜 / 成就系统云函数
// action: recordAdd | recordSave | recordExpired | getStats
//
// 成就统计（跟随视角，队内操作双写）：
// - 个人空间操作（teamId 为空/'personal'）：计入操作者个人聚合 user_stats
// - 队伍操作（teamId = 队伍 id）：同时计入队伍聚合 team_stats 与操作者个人聚合 user_stats，
//   保证个人排行的信息完整——「超过 xx% 用户」拿所有人的信息排名，
//   不管贡献发生在个人空间还是队伍内
//
// stat_events 集合（贡献明细账本）：
// { _openid, teamId, itemId, type, value, createdAt }
// 同一 (teamId, itemId, type) 只记一次，防止多人重复操作同一物品虚增统计；
// 退出队伍时按 (openid, teamId) 删除事件并扣减队伍聚合（剥离贡献，个人聚合保留）
//
// 排行榜跟随视角（getStats）：
// - 个人视角：个人统计 + 全网个人百分位 + 全体个人排行列表
// - 队伍视角：队伍统计 + 全网队伍百分位 + 队内成员贡献排行列表
//
// user_stats 集合结构：
// { _openid, totalTracked, totalSaved, totalSavedValue, totalExpired, updatedAt }
// team_stats 集合结构：
// { teamId, totalTracked, totalSaved, totalSavedValue, totalExpired, updatedAt }

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

const COLLECTIONS = {
  USER_STATS: 'user_stats',
  TEAM_STATS: 'team_stats',
  EVENTS: 'stat_events',
  MEMBERS: 'teamMembers'
}

const PERSONAL = 'personal'
const RANKING_LIMIT = 100

exports.main = async (event, context) => {
  const { action } = event
  const openid = cloud.getWXContext().OPENID

  try {
    switch (action) {
      case 'recordAdd':
        return await recordAdd(openid, event.teamId, event.itemId)
      case 'recordSave':
        return await recordSave(openid, event.value, event.teamId, event.itemId)
      case 'recordExpired':
        return await recordExpired(openid, event.teamId, event.itemId)
      case 'getStats':
        return await getStats(openid, event.teamId)
      default:
        return { code: -1, msg: '未知操作: ' + action }
    }
  } catch (err) {
    console.error(`[leaderboard:${action}] 失败:`, err)
    return { code: -1, msg: err.message }
  }
}

// teamId 为空或 'personal' 视为个人维度
function resolveTeamId(teamId) {
  return teamId && teamId !== PERSONAL ? teamId : PERSONAL
}

// 队伍维度操作需校验操作者是否为该队伍成员
async function isTeamMember(openid, teamId) {
  const res = await db.collection(COLLECTIONS.MEMBERS)
    .where({ teamId, openid })
    .count()
  return res.total > 0
}

// 获取或创建个人统计记录
async function getOrCreatePersonalStats(openid) {
  const res = await db.collection(COLLECTIONS.USER_STATS).where({ _openid: openid }).get()
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
  const addRes = await db.collection(COLLECTIONS.USER_STATS).add({ data: newRecord })
  return { _id: addRes._id, ...newRecord }
}

// 获取或创建队伍统计记录
async function getOrCreateTeamStats(teamId) {
  const res = await db.collection(COLLECTIONS.TEAM_STATS).where({ teamId }).get()
  if (res.data.length > 0) {
    return res.data[0]
  }

  const newRecord = {
    teamId,
    totalTracked: 0,
    totalSaved: 0,
    totalSavedValue: 0,
    totalExpired: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  const addRes = await db.collection(COLLECTIONS.TEAM_STATS).add({ data: newRecord })
  return { _id: addRes._id, ...newRecord }
}

// 写账本事件：同一 (teamId, itemId, type) 只记一次；返回是否真正写入
async function recordEvent(openid, teamId, itemId, type, value) {
  // 未传 itemId 时跳过去重（兼容旧版本调用），保持每次计数的原行为
  if (itemId) {
    const dup = await db.collection(COLLECTIONS.EVENTS)
      .where({ teamId, itemId, type })
      .count()
    if (dup.total > 0) return false
  }

  await db.collection(COLLECTIONS.EVENTS).add({
    data: {
      _openid: openid,
      teamId,
      itemId: itemId || '',
      type,
      value: parseFloat(value) || 0,
      createdAt: new Date().toISOString()
    }
  })
  return true
}

// 按事件类型对指定聚合文档累加
async function incAggregate(collection, docId, type, value) {
  const data = { updatedAt: new Date().toISOString() }
  if (type === 'tracked') {
    data.totalTracked = _.inc(1)
  } else if (type === 'saved') {
    data.totalSaved = _.inc(1)
    data.totalSavedValue = _.inc(value)
  } else if (type === 'expired') {
    data.totalExpired = _.inc(1)
  }
  await db.collection(collection).doc(docId).update({ data })
}

// 记录事件并更新聚合：
// 个人操作只记 user_stats；队伍操作双写 user_stats（操作者个人） + team_stats（队伍）
async function recordAndAggregate(openid, teamId, itemId, type, value) {
  const t = resolveTeamId(teamId)
  if (t !== PERSONAL && !(await isTeamMember(openid, t))) {
    return { code: -1, msg: '你不是该队伍的成员' }
  }

  const recorded = await recordEvent(openid, t, itemId, type, value)
  if (!recorded) return { code: 0 }

  const val = parseFloat(value) || 0

  // 个人聚合总是累计：保证个人排行覆盖所有用户的全部贡献
  const personal = await getOrCreatePersonalStats(openid)
  await incAggregate(COLLECTIONS.USER_STATS, personal._id, type, val)

  // 队伍聚合
  if (t !== PERSONAL) {
    const team = await getOrCreateTeamStats(t)
    await incAggregate(COLLECTIONS.TEAM_STATS, team._id, type, val)
  }

  return { code: 0 }
}

// 记录添加物品（tracked）
async function recordAdd(openid, teamId, itemId) {
  return recordAndAggregate(openid, teamId, itemId, 'tracked', 0)
}

// 记录避免过期（标记省钱 / 删除未过期物品），value 为物品价值
async function recordSave(openid, value, teamId, itemId) {
  return recordAndAggregate(openid, teamId, itemId, 'saved', value)
}

// 记录已过期（删除已过期物品）
async function recordExpired(openid, teamId, itemId) {
  return recordAndAggregate(openid, teamId, itemId, 'expired', 0)
}

// 获取指定视角统计 + 排行列表（跟随视角）
async function getStats(openid, teamId) {
  const t = resolveTeamId(teamId)
  if (t === PERSONAL) {
    return getPersonalStats(openid)
  }
  if (!(await isTeamMember(openid, t))) {
    return { code: -1, msg: '你不是该队伍的成员' }
  }
  return getTeamStats(t, openid)
}

// 个人视角：个人统计 + 全网个人百分位/排名 + 全体个人排行
async function getPersonalStats(openid) {
  const stats = await getOrCreatePersonalStats(openid)

  // 百分位与排名：全体个人用户的完整统计（含队伍贡献，因队内操作双写）
  const totalRes = await db.collection(COLLECTIONS.USER_STATS).count()
  const totalUsers = totalRes.total
  const belowRes = await db.collection(COLLECTIONS.USER_STATS)
    .where({ totalSavedValue: _.lt(stats.totalSavedValue || 0) })
    .count()
  const usersBelow = belowRes.total
  const percentile = totalUsers > 0 ? Math.round((usersBelow / totalUsers) * 100) : 0
  const rank = usersBelow + 1

  // 全体个人排行列表
  const rankingRes = await db.collection(COLLECTIONS.USER_STATS)
    .orderBy('totalSavedValue', 'desc')
    .orderBy('totalSaved', 'desc')
    .limit(RANKING_LIMIT)
    .get()
  const ranking = rankingRes.data.map((u, i) => ({
    rank: i + 1,
    name: u._openid === openid ? '我' : '用户' + u._openid.slice(-4),
    totalTracked: u.totalTracked || 0,
    totalSaved: u.totalSaved || 0,
    totalSavedValue: u.totalSavedValue || 0,
    totalExpired: u.totalExpired || 0,
    isMine: u._openid === openid
  }))

  return {
    code: 0,
    data: {
      view: 'personal',
      totalTracked: stats.totalTracked || 0,
      totalSaved: stats.totalSaved || 0,
      totalSavedValue: stats.totalSavedValue || 0,
      totalExpired: stats.totalExpired || 0,
      percentile,
      rank,
      totalUsers,
      ranking
    }
  }
}

// 队伍视角：队伍统计 + 全网队伍百分位/排名 + 队内成员贡献排行
async function getTeamStats(teamId, openid) {
  const stats = await getOrCreateTeamStats(teamId)

  // 百分位与排名：全体队伍
  const totalRes = await db.collection(COLLECTIONS.TEAM_STATS).count()
  const totalTeams = totalRes.total
  const belowRes = await db.collection(COLLECTIONS.TEAM_STATS)
    .where({ totalSavedValue: _.lt(stats.totalSavedValue || 0) })
    .count()
  const teamsBelow = belowRes.total
  const percentile = totalTeams > 0 ? Math.round((teamsBelow / totalTeams) * 100) : 0
  const rank = teamsBelow + 1

  // 队内成员贡献排行：账本按成员聚合
  const ranking = await getTeamMemberRanking(teamId, openid)

  return {
    code: 0,
    data: {
      view: 'team',
      teamId,
      totalTracked: stats.totalTracked || 0,
      totalSaved: stats.totalSaved || 0,
      totalSavedValue: stats.totalSavedValue || 0,
      totalExpired: stats.totalExpired || 0,
      percentile,
      rank,
      totalUsers: totalTeams,
      ranking
    }
  }
}

// 队内成员贡献排行：聚合账本（$group）；聚合失败时降级为内存聚合
async function getTeamMemberRanking(teamId, openid) {
  try {
    const aggRes = await db.collection(COLLECTIONS.EVENTS)
      .aggregate()
      .match({ teamId })
      .group({
        _id: '$_openid',
        totalTracked: $.sum($.cond({ if: $.eq(['$type', 'tracked']), then: 1, else: 0 })),
        totalSaved: $.sum($.cond({ if: $.eq(['$type', 'saved']), then: 1, else: 0 })),
        totalSavedValue: $.sum($.cond({ if: $.eq(['$type', 'saved']), then: '$value', else: 0 })),
        totalExpired: $.sum($.cond({ if: $.eq(['$type', 'expired']), then: 1, else: 0 }))
      })
      .sort({ totalSavedValue: -1, totalSaved: -1 })
      .limit(RANKING_LIMIT)
      .end()

    const list = aggRes.list || []
    return list.map((m, i) => ({
      rank: i + 1,
      name: m._id === openid ? '我' : '成员' + m._id.slice(-4),
      totalTracked: m.totalTracked || 0,
      totalSaved: m.totalSaved || 0,
      totalSavedValue: m.totalSavedValue || 0,
      totalExpired: m.totalExpired || 0,
      isMine: m._id === openid
    }))
  } catch (err) {
    console.error('账本聚合失败，降级为内存聚合:', err)
    return fallbackTeamMemberRanking(teamId, openid)
  }
}

// 降级方案：全量拉取账本在内存聚合（最多 1000 条）
async function fallbackTeamMemberRanking(teamId, openid) {
  const res = await db.collection(COLLECTIONS.EVENTS)
    .where({ teamId })
    .limit(1000)
    .get()

  const map = {}
  for (const ev of res.data) {
    if (!map[ev._openid]) {
      map[ev._openid] = { openid: ev._openid, totalTracked: 0, totalSaved: 0, totalSavedValue: 0, totalExpired: 0 }
    }
    const m = map[ev._openid]
    if (ev.type === 'tracked') {
      m.totalTracked += 1
    } else if (ev.type === 'saved') {
      m.totalSaved += 1
      m.totalSavedValue += ev.value || 0
    } else if (ev.type === 'expired') {
      m.totalExpired += 1
    }
  }

  const list = Object.values(map).sort((a, b) => {
    const diff = (b.totalSavedValue || 0) - (a.totalSavedValue || 0)
    if (diff !== 0) return diff
    return (b.totalSaved || 0) - (a.totalSaved || 0)
  })

  return list.map((m, i) => ({
    rank: i + 1,
    name: m.openid === openid ? '我' : '成员' + m.openid.slice(-4),
    totalTracked: m.totalTracked,
    totalSaved: m.totalSaved,
    totalSavedValue: m.totalSavedValue,
    totalExpired: m.totalExpired,
    isMine: m.openid === openid
  }))
}
