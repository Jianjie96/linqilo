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
    achievementSub: '',
    levelMark: 'I',
    levelName: '新手守护者',
    totalSaved: 0,
    estimatedSaved: 0,
    earnedBadges: 0
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

      const totalSaved = data.totalSaved || 0
      // 每件物品按均价 ¥35 估算节省金额
      const estimatedSaved = totalSaved * 35
      // 等级计算
      const level = this.calcLevel(totalSaved)
      // 徽章计算
      const badges = this.calcBadges(data)
      const earnedBadges = badges.filter(b => b.earned).length

      let text = ''
      let sub = ''
      if (totalSaved > 0) {
        text = `已避免 ${totalSaved} 件物品过期`
        if (data.totalUsers > 0 && data.percentile > 0) {
          sub = `超过 ${data.percentile}% 的用户，查看详情`
        } else {
          sub = '查看你的成就详情'
        }
      } else if (data.totalTracked > 0) {
        text = `正在追踪 ${data.totalTracked} 件物品`
        sub = '及时使用，避免过期'
      } else {
        text = '开启你的物品守护之旅'
        sub = '添加物品，追踪到期日'
      }

      this.setData({
        achievementText: text,
        achievementSub: sub,
        levelMark: level.mark,
        levelName: level.name,
        totalSaved,
        estimatedSaved,
        earnedBadges
      })
    } catch (err) {
      // 云函数未部署时静默失败
    }
  },

  // 等级计算（与 leaderboard 保持一致）
  calcLevel(totalSaved) {
    const LEVELS = [
      { min: 0, max: 4, mark: 'I', name: '新手守护者' },
      { min: 5, max: 19, mark: 'II', name: '过期终结者' },
      { min: 20, max: 49, mark: 'III', name: '防腐达人' },
      { min: 50, max: 99, mark: 'IV', name: '节约大师' },
      { min: 100, max: Infinity, mark: 'V', name: '零浪费传奇' }
    ]
    for (let i = LEVELS.length - 1; i >= 0; i--) {
      if (totalSaved >= LEVELS[i].min) return LEVELS[i]
    }
    return LEVELS[0]
  },

  // 徽章计算（与 leaderboard 保持一致）
  calcBadges(stats) {
    const BADGE_DEFS = [
      { id: 'first_save', threshold: { type: 'totalSaved', value: 1 } },
      { id: 'tracker_10', threshold: { type: 'totalTracked', value: 10 } },
      { id: 'save_10', threshold: { type: 'totalSaved', value: 10 } },
      { id: 'tracker_50', threshold: { type: 'totalTracked', value: 50 } },
      { id: 'save_50', threshold: { type: 'totalSaved', value: 50 } },
      { id: 'tracker_100', threshold: { type: 'totalTracked', value: 100 } },
      { id: 'save_100', threshold: { type: 'totalSaved', value: 100 } },
      { id: 'rank_top10', threshold: { type: 'percentile', value: 90 } }
    ]
    return BADGE_DEFS.map(def => ({
      id: def.id,
      earned: (stats[def.threshold.type] || 0) >= def.threshold.value
    }))
  },

  // --- 左滑删除 ---

  onTouchStart(e) {
    const id = e.currentTarget.dataset.id
    this._touchStartX = e.touches[0].clientX
    this._touchStartY = e.touches[0].clientY
    this._swipeTargetId = id
  },

  onTouchMove(e) {
    const id = e.currentTarget.dataset.id
    const deltaX = e.touches[0].clientX - this._touchStartX
    const deltaY = e.touches[0].clientY - this._touchStartY

    // 竖直滑动 > 水平滑动，不触发左滑
    if (Math.abs(deltaY) > Math.abs(deltaX)) return

    // 只允许左滑（负方向），右滑回弹
    const px = Math.min(0, Math.max(-120, deltaX / 2))
    this._updateItemSwipe(id, px, true)
  },

  onTouchEnd(e) {
    const id = e.currentTarget.dataset.id
    const deltaX = e.changedTouches[0] ? e.changedTouches[0].clientX - this._touchStartX : 0

    // 滑动超过 50rpx 展开，否则收回
    const items = this.data.items.map(item => {
      if (item.id === id) {
        return { ...item, _swipeX: deltaX < -50 ? -120 : 0, _swiping: false }
      }
      return item
    })
    this.setData({ items })
  },

  _updateItemSwipe(id, px, swiping) {
    const items = this.data.items.map(item => {
      if (item.id === id) {
        return { ...item, _swipeX: px, _swiping: swiping }
      }
      // 关闭其他卡片的滑动状态
      if (item._swipeX && item._swipeX !== 0) {
        return { ...item, _swipeX: 0, _swiping: false }
      }
      return item
    })
    this.setData({ items })
  },

  // 删除物品
  onDeleteItem(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.items.find(i => i.id === id)
    if (!item) return

    wx.showModal({
      title: '确认删除',
      content: `确定要删除「${item.name}」吗？`,
      confirmColor: '#FF3B30',
      confirmText: '删除',
      success: async (res) => {
        if (!res.confirm) {
          // 取消：收回滑动
          const items = this.data.items.map(i =>
            i.id === id ? { ...i, _swipeX: 0, _swiping: false } : i
          )
          this.setData({ items })
          return
        }

        wx.showLoading({ title: '删除中...' })
        try {
          await app.deleteItem(id)

          // 记录统计数据
          const daysRemaining = item.daysRemaining
          if (daysRemaining >= 0) {
            syncUtil.recordSave()
          } else {
            syncUtil.recordExpired()
          }

          wx.hideLoading()
          wx.showToast({ title: '已删除', icon: 'success' })
          this._renderItems()
          this.loadAchievementBanner()
        } catch (err) {
          wx.hideLoading()
          console.error('删除失败:', err)
          wx.showToast({ title: '删除失败，请重试', icon: 'none' })
        }
      }
    })
  },

  // 下拉刷新
  async onPullDownRefresh() {
    await this.refreshItems()
    this.loadAchievementBanner()
    wx.stopPullDownRefresh()
  }
})
