const syncUtil = require('../../utils/sync.js')

// 等级定义
const LEVELS = [
  { min: 0, max: 4, icon: '🌱', name: '新手守护者', nextName: '过期终结者' },
  { min: 5, max: 19, icon: '🛡️', name: '过期终结者', nextName: '防腐达人' },
  { min: 20, max: 49, icon: '⚡', name: '防腐达人', nextName: '节约大师' },
  { min: 50, max: 99, icon: '🏆', name: '节约大师', nextName: '零浪费传奇' },
  { min: 100, max: Infinity, icon: '👑', name: '零浪费传奇', nextName: '' }
]

// 徽章定义
const BADGE_DEFS = [
  { id: 'first_save', icon: '🛡️', name: '初次守护', desc: '首次避免物品过期', threshold: { type: 'totalSaved', value: 1 } },
  { id: 'tracker_10', icon: '📦', name: '管理达人', desc: '追踪10件物品', threshold: { type: 'totalTracked', value: 10 } },
  { id: 'save_10', icon: '⭐', name: '节约之星', desc: '避免10件过期', threshold: { type: 'totalSaved', value: 10 } },
  { id: 'tracker_50', icon: '🎯', name: '精准管理', desc: '追踪50件物品', threshold: { type: 'totalTracked', value: 50 } },
  { id: 'save_50', icon: '💎', name: '零浪费先锋', desc: '避免50件过期', threshold: { type: 'totalSaved', value: 50 } },
  { id: 'tracker_100', icon: '🔥', name: '百件达人', desc: '追踪100件物品', threshold: { type: 'totalTracked', value: 100 } },
  { id: 'save_100', icon: '👑', name: '守护传说', desc: '避免100件过期', threshold: { type: 'totalSaved', value: 100 } },
  { id: 'rank_top10', icon: '🏅', name: '榜上留名', desc: '进入全网前10%', threshold: { type: 'percentile', value: 90 } }
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
  data: {
    loading: true,
    stats: {
      totalTracked: 0,
      totalSaved: 0,
      totalExpired: 0,
      percentile: 0,
      rank: 0,
      totalUsers: 0
    },
    saveRate: 0,
    levelInfo: {},
    levelProgress: 0,
    badges: [],
    earnedBadges: 0,
    encourageText: ''
  },

  onLoad() {
    this.loadStats()
  },

  onShow() {
    if (!this.data.loading) {
      this.loadStats()
    }
  },

  async loadStats() {
    this.setData({ loading: true })

    try {
      const result = await syncUtil.getLeaderboardStats()
      const stats = result.data || {
        totalTracked: 0,
        totalSaved: 0,
        totalExpired: 0,
        percentile: 0,
        rank: 0,
        totalUsers: 0
      }

      // 守护率：避免过期 / (避免过期 + 已过期)
      const totalHandled = stats.totalSaved + stats.totalExpired
      const saveRate = totalHandled > 0 ? Math.round((stats.totalSaved / totalHandled) * 100) : 0

      // 等级信息
      const levelInfo = this.calcLevel(stats.totalSaved)

      // 等级进度
      const levelProgress = this.calcLevelProgress(stats.totalSaved, levelInfo)

      // 徽章
      const badges = this.calcBadges(stats)
      const earnedBadges = badges.filter(b => b.earned).length

      // 鼓励语
      const encourageText = this.getEncourage(stats, levelInfo)

      this.setData({
        stats,
        saveRate,
        levelInfo,
        levelProgress,
        badges,
        earnedBadges,
        encourageText,
        loading: false
      })
    } catch (err) {
      console.error('加载成就数据失败:', err)
      // 降级：显示本地空数据
      const stats = { totalTracked: 0, totalSaved: 0, totalExpired: 0, percentile: 0, rank: 0, totalUsers: 0 }
      const levelInfo = this.calcLevel(0)
      this.setData({
        stats,
        saveRate: 0,
        levelInfo,
        levelProgress: 0,
        badges: this.calcBadges(stats),
        earnedBadges: 0,
        encourageText: ENCOURAGES.zero,
        loading: false
      })
    }
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
          icon: level.icon,
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
        icon: def.icon,
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
    await this.loadStats()
    wx.stopPullDownRefresh()
  },

  // 分享
  onShareAppMessage() {
    const { stats, levelInfo } = this.data
    return {
      title: `我已成功避免了${stats.totalSaved}件物品过期，${stats.totalUsers > 0 ? `超过${stats.percentile}%的用户！` : '快来挑战我吧！'}`,
      path: '/pages/leaderboard/leaderboard',
      imageUrl: ''
    }
  }
})
