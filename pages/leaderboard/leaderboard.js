const app = getApp()
const syncUtil = require('../../utils/sync.js')
const shareMixin = require('../../utils/share.js')

// 等级定义（mark 用阿拉伯数字，避免罗马数字 'II' 被误读为「11」）
const LEVELS = [
  { min: 0, max: 4, mark: '1', name: '新手守护者', nextName: '过期终结者' },
  { min: 5, max: 19, mark: '2', name: '过期终结者', nextName: '防腐达人' },
  { min: 20, max: 49, mark: '3', name: '防腐达人', nextName: '节约大师' },
  { min: 50, max: 99, mark: '4', name: '节约大师', nextName: '零浪费传奇' },
  { min: 100, max: Infinity, mark: '5', name: '零浪费传奇', nextName: '' }
]

// 徽章定义
const BADGE_DEFS = [
  { id: 'first_save', name: '初次守护', desc: '首次避免物品过期', threshold: { type: 'totalSaved', value: 1 } },
  { id: 'tracker_10', name: '管理达人', desc: '追踪10件物品', threshold: { type: 'totalTracked', value: 10 } },
  { id: 'save_10', name: '节约之星', desc: '避免10件过期', threshold: { type: 'totalSaved', value: 10 } },
  { id: 'tracker_50', name: '精准管理', desc: '追踪50件物品', threshold: { type: 'totalTracked', value: 50 } },
  { id: 'save_50', name: '零浪费先锋', desc: '避免50件过期', threshold: { type: 'totalSaved', value: 50 } },
  { id: 'tracker_100', name: '百件达人', desc: '追踪100件物品', threshold: { type: 'totalTracked', value: 100 } },
  { id: 'save_100', name: '守护传说', desc: '避免100件过期', threshold: { type: 'totalSaved', value: 100 } },
  { id: 'rank_top10', name: '榜上留名', desc: '进入全网前10%', threshold: { type: 'percentile', value: 90 } }
]

// 鼓励语
const ENCOURAGES = {
  zero: '从添加第一件物品开始，记录每一次及时使用，成为零浪费达人！',
  beginner: '好的开始是成功的一半，继续保持及时管理的习惯！',
  intermediate: '你已养成良好的物品管理习惯，超过了大多数用户！',
  advanced: '你是当之无愧的节约大师，向零浪费传奇进发！',
  master: '零浪费传奇非你莫属，感谢你为减少浪费做出的贡献！'
}

Page({
  ...shareMixin,
  data: {
    loading: true,
    // 跟随视角：等级/价值/统计按视角聚合；排行列表个人=全体个人，队伍=队内成员
    isTeamView: false,
    teamName: '',
    stats: {
      totalTracked: 0,
      totalSaved: 0,
      totalSavedValue: 0,
      totalExpired: 0,
      percentile: 0,
      rank: 0,
      totalSubjects: 0
    },
    saveRate: 0,
    levelInfo: {},
    levelProgress: 0,
    badges: [],
    earnedBadges: 0,
    encourageText: '',
    ranking: []
  },

  _lastTeamId: null,

  onLoad() {
    this.loadStats()
  },

  onShow() {
    // 视角可能已在首页切换（或从队伍页更换绑定），按当前视角刷新
    const teamId = app.getViewGroupId()
    if (this._lastTeamId !== teamId) {
      this.loadStats(teamId)
    }
  },

  async loadStats(teamId) {
    if (teamId === undefined) teamId = app.getViewGroupId()
    this._lastTeamId = teamId
    this.setData({ loading: true })

    const isTeamView = !!teamId

    try {
      const result = await syncUtil.getLeaderboardStats(teamId)
      const data = result.data || {}
      const stats = {
        totalTracked: data.totalTracked || 0,
        totalSaved: data.totalSaved || 0,
        totalSavedValue: data.totalSavedValue || 0,
        totalExpired: data.totalExpired || 0,
        percentile: data.percentile || 0,
        rank: data.rank || 0,
        totalSubjects: data.totalSubjects || 0
      }

      // 守护率：避免过期 / (避免过期 + 已过期)
      const totalHandled = stats.totalSaved + stats.totalExpired
      const saveRate = totalHandled > 0 ? Math.round((stats.totalSaved / totalHandled) * 100) : 0

      // 等级与徽章：等级跟随视角（队伍视角按队伍统计计算），徽章仅个人视角展示
      const levelInfo = this.calcLevel(stats.totalSaved)
      const levelProgress = this.calcLevelProgress(stats.totalSaved, levelInfo)
      const badges = this.calcBadges(stats)
      const earnedBadges = badges.filter(b => b.earned).length
      const encourageText = this.getEncourage(stats, levelInfo)

      this.setData({
        isTeamView,
        teamName: isTeamView ? this.findTeamName(teamId) : '',
        stats,
        saveRate,
        levelInfo,
        levelProgress,
        badges,
        earnedBadges,
        encourageText,
        ranking: data.ranking || [],
        loading: false
      })
    } catch (err) {
      console.error('加载成就数据失败:', err)
      // 降级：显示本地空数据
      const stats = { totalTracked: 0, totalSaved: 0, totalSavedValue: 0, totalExpired: 0, percentile: 0, rank: 0, totalSubjects: 0 }
      const levelInfo = this.calcLevel(0)
      this.setData({
        isTeamView,
        teamName: isTeamView ? this.findTeamName(teamId) : '',
        stats,
        saveRate: 0,
        levelInfo,
        levelProgress: 0,
        badges: this.calcBadges(stats),
        earnedBadges: 0,
        encourageText: ENCOURAGES.zero,
        ranking: [],
        loading: false
      })
    }
  },

  // 查找视角对应的队伍名称
  findTeamName(teamId) {
    const team = app.globalData.teams.find(t => t.teamId === teamId)
    return team ? team.name : '队伍'
  },

  // 计算等级
  calcLevel(totalSaved) {
    for (let i = LEVELS.length - 1; i >= 0; i--) {
      if (totalSaved >= LEVELS[i].min) {
        const level = LEVELS[i]
        const isMax = level.max === Infinity
        const nextThreshold = isMax ? level.min : (level.max + 1)
        const remaining = isMax ? 0 : (nextThreshold - totalSaved)
        return {
          mark: level.mark,
          name: level.name,
          currentName: level.name,
          nextName: level.nextName,
          nextThreshold,
          remaining,
          isMax,
          min: level.min
        }
      }
    }
    return LEVELS[0]
  },

  // 计算等级进度百分比
  calcLevelProgress(totalSaved, levelInfo) {
    if (levelInfo.isMax) return 100
    const range = levelInfo.nextThreshold - levelInfo.min
    if (range === 0) return 0
    return Math.min(100, Math.round(((totalSaved - levelInfo.min) / range) * 100))
  },

  // 计算徽章
  calcBadges(stats) {
    return BADGE_DEFS.map(def => {
      let earned = false
      const val = stats[def.threshold.type] || 0
      if (val >= def.threshold.value) {
        earned = true
      }
      return {
        id: def.id,
        name: def.name,
        desc: def.desc,
        earned
      }
    })
  },

  // 获取鼓励语
  getEncourage(stats, levelInfo) {
    if (stats.totalSaved === 0) return ENCOURAGES.zero
    if (levelInfo.isMax) return ENCOURAGES.master
    if (stats.totalSaved >= 50) return ENCOURAGES.advanced
    if (stats.totalSaved >= 10) return ENCOURAGES.intermediate
    return ENCOURAGES.beginner
  },

  // 下拉刷新
  async onPullDownRefresh() {
    await this.loadStats(app.getViewGroupId())
    wx.stopPullDownRefresh()
  },

  // 分享
  onShareAppMessage() {
    const { stats, isTeamView } = this.data
    const rivalWord = isTeamView ? '团队' : '用户'
    if (isTeamView) {
      return {
        title: `我们队伍已避免${stats.totalSaved}件物品过期，${stats.totalSubjects > 0 ? `超过全网${stats.percentile}%的团队！` : '一起守护物品吧！'}`,
        path: '/pages/leaderboard/leaderboard',
        imageUrl: ''
      }
    }
    return {
      title: `我已成功避免了${stats.totalSaved}件物品过期，${stats.totalSubjects > 0 ? `超过全网${stats.percentile}%的${rivalWord}！` : '快来挑战我吧！'}`,
      path: '/pages/leaderboard/leaderboard',
      imageUrl: ''
    }
  }
})
