const util = require('../../utils/util.js')
const syncUtil = require('../../utils/sync.js')
const app = getApp()

Page({
  data: {
    items: [],
    filterTab: 'all', // all | safe | warning | expired
    isEmpty: false,
    safeCount: 0,
    warningCount: 0,
    expiredCount: 0,
    achievementText: '',
    achievementSub: ''
  },

  _dataLoaded: false, // 是否已加载过数据

  onShow() {
    if (this._dataLoaded) {
      // 从子页面返回：缓存已是最新（add/detail 直接修改了 globalData），只需重新渲染 UI
      this._renderItems()
    } else {
      // 首次进入：从云端拉取
      this._dataLoaded = true
      this.refreshItems()
    }
    this.loadAchievementBanner()
  },

  // 从云端拉取并渲染
  async refreshItems() {
    await app.loadItems()
    this._renderItems()
  },

  // 仅从缓存渲染（不发网络请求）
  _renderItems() {
    const rawItems = app.globalData.items
    const alertDays = app.globalData.settings.alertDays

    const items = rawItems.map(item => {
      const daysRemaining = util.calcDaysRemaining(item.expiryDate)
      const status = util.getItemStatus(item.expiryDate, item.alertDays || alertDays)
      const countdownText = util.getCountdownText(item.expiryDate)
      const statusText = util.getStatusText(status)

      return {
        ...item,
        daysRemaining,
        status,
        countdownText,
        statusText,
        expiryDateFormatted: item.expiryDate
      }
    })

    // 按到期日期排序
    const sorted = util.sortItemsByExpiry(items)

    // 统计各状态数量
    const safeCount = sorted.filter(i => i.status === 'safe').length
    const warningCount = sorted.filter(i => i.status === 'warning' || i.status === 'danger').length
    const expiredCount = sorted.filter(i => i.status === 'expired').length

    this.setData({
      items: sorted,
      isEmpty: sorted.length === 0,
      safeCount,
      warningCount,
      expiredCount
    })
  },

  // 切换筛选
  onFilterTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ filterTab: tab })
  },

  // 获取筛选后的列表
  getFilteredItems() {
    const { items, filterTab } = this.data
    switch (filterTab) {
      case 'safe':
        return items.filter(i => i.status === 'safe')
      case 'warning':
        return items.filter(i => i.status === 'warning' || i.status === 'danger')
      case 'expired':
        return items.filter(i => i.status === 'expired')
      default:
        return items
    }
  },

  // 跳转添加
  goAdd() {
    wx.navigateTo({ url: '/pages/add/add' })
  },

  // 跳转排行榜
  goLeaderboard() {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard' })
  },

  // 跳转设置
  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' })
  },

  // 跳转详情
  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
  },

  // 加载成就横幅文案
  async loadAchievementBanner() {
    try {
      const result = await syncUtil.getLeaderboardStats()
      const data = result.data
      if (!data) return

      let text = ''
      let sub = ''
      if (data.totalSaved > 0) {
        text = `已避免 ${data.totalSaved} 件物品过期`
        if (data.totalUsers > 0 && data.percentile > 0) {
          sub = `超过 ${data.percentile}% 的用户，点击查看 ›`
        } else {
          sub = '点击查看你的成就 ›'
        }
      } else if (data.totalTracked > 0) {
        text = `正在追踪 ${data.totalTracked} 件物品`
        sub = '及时使用，避免过期 ›'
      } else {
        text = '开启你的物品守护之旅'
        sub = '添加物品，追踪到期日 ›'
      }

      this.setData({ achievementText: text, achievementSub: sub })
    } catch (err) {
      // 云函数未部署时静默失败
    }
  },

  // 下拉刷新
  async onPullDownRefresh() {
    await this.refreshItems()
    this.loadAchievementBanner()
    wx.stopPullDownRefresh()
  }
})
