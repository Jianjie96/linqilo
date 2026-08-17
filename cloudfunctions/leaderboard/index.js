// 排行榜 / 成就系统云函数
// action: recordAdd | recordSave | recordExpired | getStats
//
// 成就统计（跟随视角，队内操作双写）：
// - 个人空间操作（teamId 为空/'personal'）：计入操作者个人聚合 user_stats
// - 队伍操作（teamId = 队伍 id）：同时计入队伍聚合 team_stats 与操作者个人聚合 user_stats，
//   保证个人排行的信息完整——「超过全网 xx%」拿所有人的信息排名，
//   不管贡献发生在个人空间还是队伍内
//
// stat_events 集合（贡献明细账本）：
// { _openid, teamId, itemId, type, value, createdAt }
// 同一 (teamId, itemId, type) 只记一次，防止多人重复操作同一物品虚增统计；
// 数据归属队伍：退出不剥离贡献，队伍解散时账本与聚合随队清理
//
// 排行榜跟随视角（getStats）：
// - 个人视角：个人统计 + 全体个人排行列表；等级/价值跟随个人聚合
// - 队伍视角：队伍统计 + 队内成员贡献排行列表；等级/价值跟随队伍聚合
// - 「超过全网 xx%」：混合池口径——统计所有个人（user_stats）与所有队伍（team_stats）再排名
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
  MEMBERS: 'teamMembers',
  TEAMS: 'teams',
  USERS: 'users'
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
        return await getStats(openid, event.teamId, event.scope)
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
// 历史「先查后插」并发竞态可能产生同一 openid 的重复记录：
// 合并为一条（数值求和）并清理多余记录，保证排行列表与名次卡片读取同一份数据
async function getOrCreatePersonalStats(openid) {
  const res = await db.collection(COLLECTIONS.USER_STATS).where({ _openid: openid }).limit(100).get()
  if (res.data.length === 1) {
    return res.data[0]
  }
  if (res.data.length > 1) {
    return mergeStatDocs(COLLECTIONS.USER_STATS, res.data)
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

// 获取或创建队伍统计记录（同样做重复记录自愈合并）
async function getOrCreateTeamStats(teamId) {
  const res = await db.collection(COLLECTIONS.TEAM_STATS).where({ teamId }).limit(100).get()
  if (res.data.length === 1) {
    return res.data[0]
  }
  if (res.data.length > 1) {
    return mergeStatDocs(COLLECTIONS.TEAM_STATS, res.data)
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

// 合并同一主体的重复统计记录：数值字段求和，保留首条、删除其余，返回合并后的记录
async function mergeStatDocs(collection, docs) {
  const sums = { totalTracked: 0, totalSaved: 0, totalSavedValue: 0, totalExpired: 0 }
  docs.forEach(d => {
    sums.totalTracked += d.totalTracked || 0
    sums.totalSaved += d.totalSaved || 0
    sums.totalSavedValue += d.totalSavedValue || 0
    sums.totalExpired += d.totalExpired || 0
  })

  const keep = docs[0]
  await db.collection(collection).doc(keep._id).update({
    data: { ...sums, updatedAt: new Date().toISOString() }
  })
  for (let i = 1; i < docs.length; i++) {
    await db.collection(collection).doc(docs[i]._id).remove()
  }
  return { ...keep, ...sums }
}

// 全量自愈：拉取两个聚合集合，按 openid/teamId 分组，重复的合并为一条
async function healDuplicateStats() {
  const [usersRes, teamsRes] = await Promise.all([
    db.collection(COLLECTIONS.USER_STATS).limit(1000).get(),
    db.collection(COLLECTIONS.TEAM_STATS).limit(1000).get()
  ])

  const byUser = {}
  usersRes.data.forEach(d => {
    if (!d._openid) return
    ;(byUser[d._openid] = byUser[d._openid] || []).push(d)
  })
  for (const docs of Object.values(byUser)) {
    if (docs.length > 1) await mergeStatDocs(COLLECTIONS.USER_STATS, docs)
  }

  const byTeam = {}
  teamsRes.data.forEach(d => {
    if (!d.teamId) return
    ;(byTeam[d.teamId] = byTeam[d.teamId] || []).push(d)
  })
  for (const docs of Object.values(byTeam)) {
    if (docs.length > 1) await mergeStatDocs(COLLECTIONS.TEAM_STATS, docs)
  }
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
async function getStats(openid, teamId, scope) {
  // 读取前先全量自愈重复统计记录，保证名次/百分位/排行列表同口径
  await healDuplicateStats()

  const t = resolveTeamId(teamId)
  if (t === PERSONAL) {
    return getPersonalStats(openid)
  }
  if (!(await isTeamMember(openid, t))) {
    return { code: -1, msg: '你不是该队伍的成员' }
  }
  return getTeamStats(t, openid, scope || 'internal')
}

// 个人视角：个人统计 + 混合池百分位/排名 + 混合池全网排行（top10 + 自身）
async function getPersonalStats(openid) {
  const stats = await getOrCreatePersonalStats(openid)

  // 百分位与排名：混合池（所有个人 + 所有队伍），「超过全网 xx%」统一口径
  const mixed = await computeMixedPercentile(stats.totalSavedValue || 0)

  // 混合池排行：全网 top10（用户+队伍混合），若自身不在 top10 则追加
  const rankingData = await getMixedPoolRanking(openid, null, stats.totalSavedValue || 0)

  return {
    code: 0,
    data: {
      view: 'personal',
      totalTracked: stats.totalTracked || 0,
      totalSaved: stats.totalSaved || 0,
      totalSavedValue: stats.totalSavedValue || 0,
      totalExpired: stats.totalExpired || 0,
      percentile: mixed.percentile,
      rank: mixed.rank,
      totalSubjects: mixed.totalSubjects,
      ranking: rankingData.ranking,
      myRank: rankingData.myRank,
      myEntry: rankingData.myEntry
    }
  }
}

// 队伍视角：队伍统计 + 混合池百分位/排名 + 队内排行（internal）/ 全网混合池排行（global）
async function getTeamStats(teamId, openid, scope) {
  const stats = await getOrCreateTeamStats(teamId)

  // 百分位与排名：混合池（所有个人 + 所有队伍），队伍与个人同台竞技
  const mixed = await computeMixedPercentile(stats.totalSavedValue || 0)

  let ranking = []
  let myRank = 0
  let myEntry = null

  if (scope === 'global') {
    // 全网混合池排行：个人与队伍同台竞技，本队伍不在 top10 时追加
    const rankingData = await getMixedPoolRanking(null, teamId, stats.totalSavedValue || 0)
    ranking = rankingData.ranking
    myRank = rankingData.myRank
    myEntry = rankingData.myEntry
  } else {
    // 队内成员贡献排行：账本按成员聚合
    ranking = await getTeamMemberRanking(teamId, openid)
  }

  return {
    code: 0,
    data: {
      view: 'team',
      teamId,
      totalTracked: stats.totalTracked || 0,
      totalSaved: stats.totalSaved || 0,
      totalSavedValue: stats.totalSavedValue || 0,
      totalExpired: stats.totalExpired || 0,
      percentile: mixed.percentile,
      rank: mixed.rank,
      totalSubjects: mixed.totalSubjects,
      ranking,
      myRank,
      myEntry
    }
  }
}

// 混合池全网排行：用户与队伍同台竞技
// myUserId：个人视角传本人 openid；myTeamId：队伍视角 global 传本队伍 id（二者必居其一）
// 返回 top10 列表；若「我」（本人/本队伍）不在 top10，则追加条目
async function getMixedPoolRanking(myUserId, myTeamId, myValue) {
  const TOP_N = 10

  // 取用户池 top N 与队伍池 top N，合并排序后截取 top N（保证混合后前 N 名正确）
  const [usersRes, teamsRes] = await Promise.all([
    db.collection(COLLECTIONS.USER_STATS)
      .orderBy('totalSavedValue', 'desc')
      .orderBy('totalSaved', 'desc')
      .limit(TOP_N)
      .get(),
    db.collection(COLLECTIONS.TEAM_STATS)
      .orderBy('totalSavedValue', 'desc')
      .orderBy('totalSaved', 'desc')
      .limit(TOP_N)
      .get()
  ])

  const teamIds = teamsRes.data.map(t => t.teamId)
  // 本队伍可能不在 top10 列表中，需一并查询名称
  const lookupIds = myTeamId && !teamIds.includes(myTeamId) ? teamIds.concat(myTeamId) : teamIds
  const teamNameMap = await getTeamNameMap(lookupIds)

  // 批量查用户昵称（取不到时回退到 openid 后缀）
  const userOpenids = usersRes.data.map(u => u._openid)
  const nickNameMap = await getUserNickNameMap(userOpenids)

  const userEntries = usersRes.data.map(u => ({
    type: 'user',
    name: u._openid === myUserId ? '我' : (nickNameMap[u._openid] || '用户' + u._openid.slice(-4)),
    totalTracked: u.totalTracked || 0,
    totalSaved: u.totalSaved || 0,
    totalSavedValue: u.totalSavedValue || 0,
    isMine: u._openid === myUserId
  }))
  const teamEntries = teamsRes.data.map(t => ({
    type: 'team',
    name: teamNameMap[t.teamId] || '队伍' + t.teamId.slice(-4),
    totalTracked: t.totalTracked || 0,
    totalSaved: t.totalSaved || 0,
    totalSavedValue: t.totalSavedValue || 0,
    isMine: t.teamId === myTeamId
  }))

  const merged = [...userEntries, ...teamEntries].sort((a, b) => {
    const diff = (b.totalSavedValue || 0) - (a.totalSavedValue || 0)
    if (diff !== 0) return diff
    return (b.totalSaved || 0) - (a.totalSaved || 0)
  })
  const top10 = merged.slice(0, TOP_N).map((e, i) => ({ ...e, rank: i + 1 }))

  // 本人/本队伍是否已在 top10 中
  const mineInTop = top10.find(e => e.isMine)
  if (mineInTop) {
    return { ranking: top10, myRank: mineInTop.rank, myEntry: null }
  }

  // 不在 top10：计算其在混合池中的真实名次并追加
  const myRank = await computeMixedRank(myValue)
  let myEntry
  if (myTeamId) {
    myEntry = {
      type: 'team',
      name: teamNameMap[myTeamId] || '我的队伍',
      totalTracked: 0,
      totalSaved: 0,
      totalSavedValue: myValue,
      isMine: true,
      rank: myRank
    }
    // 从队伍统计中补齐追踪/避免数据
    const myStats = await getOrCreateTeamStats(myTeamId)
    myEntry.totalTracked = myStats.totalTracked || 0
    myEntry.totalSaved = myStats.totalSaved || 0
  } else {
    myEntry = {
      type: 'user',
      name: '我',
      totalTracked: 0,
      totalSaved: 0,
      totalSavedValue: myValue,
      isMine: true,
      rank: myRank
    }
    // 从个人统计中补齐追踪/避免数据
    const myStats = await getOrCreatePersonalStats(myUserId)
    myEntry.totalTracked = myStats.totalTracked || 0
    myEntry.totalSaved = myStats.totalSaved || 0
  }

  return { ranking: top10, myRank, myEntry }
}

// 计算某个价值在混合池（所有个人 + 所有队伍）中的名次（1-based）
// 并列取靠前名次：rank = 严格高于我的主体数 + 1，与全网排行列表（按值排序取索引）口径一致
async function computeMixedRank(value) {
  const [userAbove, teamAbove] = await Promise.all([
    db.collection(COLLECTIONS.USER_STATS).where({ totalSavedValue: _.gt(value) }).count(),
    db.collection(COLLECTIONS.TEAM_STATS).where({ totalSavedValue: _.gt(value) }).count()
  ])
  return userAbove.total + teamAbove.total + 1
}

// 批量获取队伍名称映射
async function getTeamNameMap(teamIds) {
  const map = {}
  if (teamIds.length === 0) return map

  const res = await db.collection(COLLECTIONS.TEAMS)
    .where({ teamId: _.in(teamIds) })
    .get()
  res.data.forEach(t => {
    map[t.teamId] = t.name || ''
  })
  return map
}

// 批量获取用户昵称映射（用户在个人中心设置过昵称才有值）
async function getUserNickNameMap(openids) {
  const map = {}
  if (openids.length === 0) return map

  const res = await db.collection(COLLECTIONS.USERS)
    .where({ openid: _.in(openids) })
    .field({ openid: true, nickName: true })
    .get()
  res.data.forEach(u => {
    if (u.nickName) map[u.openid] = u.nickName
  })
  return map
}

// 混合池百分位/排名：「超过全网 xx%」统计所有个人和队伍的数据情况再排名
// 与全网排行列表统一口径：rank = 严格高于我的主体数 + 1（并列取靠前名次），
// percentile = 被我超过（严格低于我）的主体占比；并列同分视为不输于对方，一并计入
async function computeMixedPercentile(value) {
  const [userTotal, teamTotal, userBelow, teamBelow, userEqual, teamEqual] = await Promise.all([
    db.collection(COLLECTIONS.USER_STATS).count(),
    db.collection(COLLECTIONS.TEAM_STATS).count(),
    db.collection(COLLECTIONS.USER_STATS).where({ totalSavedValue: _.lt(value) }).count(),
    db.collection(COLLECTIONS.TEAM_STATS).where({ totalSavedValue: _.lt(value) }).count(),
    db.collection(COLLECTIONS.USER_STATS).where({ totalSavedValue: value }).count(),
    db.collection(COLLECTIONS.TEAM_STATS).where({ totalSavedValue: value }).count()
  ])

  const totalSubjects = userTotal.total + teamTotal.total
  // 并列主体含自身，百分位统计需扣除自己
  const beatenOrTied = userBelow.total + teamBelow.total + userEqual.total + teamEqual.total - 1
  const percentile = totalSubjects > 1 ? Math.round((beatenOrTied / totalSubjects) * 100) : 0
  const above = totalSubjects - beatenOrTied - 1

  return { percentile, rank: above + 1, totalSubjects }
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
    // 批量查成员昵称（取不到时回退到 openid 后缀）
    const memberOpenids = list.map(m => m._id).filter(Boolean)
    const nickNameMap = await getUserNickNameMap(memberOpenids)
    return list.map((m, i) => ({
      rank: i + 1,
      name: m._id === openid ? '我' : (nickNameMap[m._id] || '成员' + m._id.slice(-4)),
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

  // 批量查成员昵称（取不到时回退到 openid 后缀）
  const memberOpenids = list.map(m => m.openid).filter(Boolean)
  const nickNameMap = await getUserNickNameMap(memberOpenids)

  return list.map((m, i) => ({
    rank: i + 1,
    name: m.openid === openid ? '我' : (nickNameMap[m.openid] || '成员' + m.openid.slice(-4)),
    totalTracked: m.totalTracked,
    totalSaved: m.totalSaved,
    totalSavedValue: m.totalSavedValue,
    totalExpired: m.totalExpired,
    isMine: m.openid === openid
  }))
}
