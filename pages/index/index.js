const util = require('../../utils/util.js')
const syncUtil = require('../../utils/sync.js')
const app = getApp()
const shareMixin = require('../../utils/share.js')

// 每屏渲染的物品数量（上拉加载更多）
const PAGE_SIZE = 20

// 分类 → 标签颜色 class 映射（与 add 页 categories 对应）
const CATEGORY_CLASS_MAP = {
  '食品': 'cat-food',
  '药品': 'cat-med',
  '化妆品': 'cat-cosmetic',
  '日用品': 'cat-daily',
  '其他': 'cat-other'
}

Page({
  ...shareMixin,
  data: {
    items: [],
    filterTab: 'all', // all | safe | warning | expired | saved
    isEmpty: false,
    visibleCount: PAGE_SIZE,
    hasMore: true,
    loadingMore: false,
    listLoadedAll: false,
    listTotal: 0,
    totalCount: 0, // 云端全量物品总数（分页模式下「全部」统计必须来自云端）
    safeCount: 0,
    warningCount: 0,
    expiredCount: 0,
    savedCount: 0,
    savedValue: 0,
    totalValue: 0,
    totalValueDisplay: 0, // 总价值 count-up 动画展示值
    showBingo: false,
    bingoAmount: 0,
    bingoItemName: '',
    achievementText: '',
    achievementSub: '',
    levelMark: '1',
    levelName: '新手守护者',
    totalSaved: 0,
    estimatedSaved: 0,
    earnedBadges: 0,
    // 自定义页头
    statusBarHeight: 20,
    headerHeight: 88,
    // 组队绑定视角
    boundTeamName: '个人',
    boundGroupId: null,
    showSwitcher: false,
    switcherOptions: [],
    _animateCards: false,
    loading: true
  },

  _dataLoaded: false, // 是否已加载过数据

  onLoad() {
    // 获取系统信息，计算自定义页头高度
    try {
      const sysInfo = wx.getSystemInfoSync()
      const statusBarHeight = sysInfo.statusBarHeight || 20
      // 页头高度 = 状态栏 + 导航栏（44px）
      const headerHeight = statusBarHeight + 44
      this.setData({ statusBarHeight, headerHeight })
    } catch (e) {
      this.setData({ statusBarHeight: 20, headerHeight: 64 })
    }
  },

  onShow() {
    // 更新绑定状态
    this._updateBindingDisplay()

    if (this._dataLoaded) {
      // 从子页面返回：缓存已是最新（add/detail 直接修改了 globalData），只需重新渲染 UI
      this._renderItems()
      this._loadStats()
    } else {
      // 首次进入：从云端拉取
      this._dataLoaded = true
      this.refreshItems()
    }
    this.loadAchievementBanner()
  },

  // 更新绑定状态显示 + 构建切换选项
  _updateBindingDisplay() {
    const { boundGroupId, boundTeamName, teams } = app.globalData
    this.setData({
      boundGroupId,
      boundTeamName: boundTeamName || '个人',
      // 构建切换选项：个人 + 已加入的队伍
      switcherOptions: [
        { teamId: null, name: '个人', icon: '👤', isActive: !boundGroupId },
        ...(teams || []).map(t => ({
          teamId: t.teamId,
          name: t.name,
          icon: '👥',
          isActive: t.teamId === boundGroupId
        }))
      ]
    })
  },

  // 切换视角下拉菜单开关
  toggleSwitcher() {
    this.setData({ showSwitcher: !this.data.showSwitcher })
  },

  // 关闭下拉菜单
  closeSwitcher() {
    this.setData({ showSwitcher: false })
  },

  // 选择切换目标
  async onSelectSwitcher(e) {
    const teamId = e.currentTarget.dataset.teamId || null
    this.setData({ showSwitcher: false })

    // 已经是当前绑定，不操作
    if (teamId === this.data.boundGroupId) return

    wx.showLoading({ title: '切换中...' })
    try {
      await app.switchBinding(teamId)
      wx.hideLoading()
      this._updateBindingDisplay()
      this.refreshItems()
      this.loadAchievementBanner()
      wx.showToast({
        title: teamId ? `已切换到队伍` : '已切换到个人',
        icon: 'success'
      })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '切换失败', icon: 'none' })
    }
  },

  // 从云端拉取第一页并渲染
  async refreshItems() {
    this.setData({ loading: true })
    const groupId = app.getBoundGroupId()
    try {
      const [{ items: pageItems, total }] = await Promise.all([
        syncUtil.fetchItemsPage(0, PAGE_SIZE, groupId),
        this._loadStats()
      ])

      app.globalData.items = pageItems
      this.setData({
        visibleCount: PAGE_SIZE,
        hasMore: pageItems.length < total,
        totalCount: total
      })
      this._renderItems(true)
    } catch (err) {
      console.error('加载失败:', err)
      this.setData({ loading: false })
    }
  },

  // 拉取云端全量统计（分页模式下本地数据是子集，统计必须来自云端）
  async _loadStats() {
    const groupId = app.getBoundGroupId()
    try {
      const stats = await syncUtil.fetchItemStats(groupId)
      this.setData({
        safeCount: stats.safe || 0,
        warningCount: stats.warning || 0,
        expiredCount: stats.expired || 0,
        savedCount: stats.savedCount || 0,
        savedValue: stats.savedValue || 0,
        totalValue: stats.totalValue || 0,
        // 云函数未部署新版本时 total 为空，保留 fetchItemsPage 已写入的云端总数
        totalCount: stats.total || this.data.totalCount
      })
      this._animateTotalValue(stats.totalValue || 0)
    } catch (err) {
      console.error('加载统计失败:', err)
    }
  },

  // 总价值 count-up 数字滚动动画（easeOutCubic 缓动）
  _animateTotalValue(target) {
    const from = this.data.totalValueDisplay || 0
    if (from === target) {
      this.setData({ totalValueDisplay: target })
      return
    }
    if (this._totalValueTimer) clearTimeout(this._totalValueTimer)

    const duration = 800
    const startTime = Date.now()

    const step = () => {
      const elapsed = Date.now() - startTime
      const progress = Math.min(elapsed / duration, 1)
      // easeOutCubic：先快后慢
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = Math.round(from + (target - from) * eased)

      if (progress >= 1) {
        this.setData({ totalValueDisplay: target })
        this._totalValueTimer = null
        return
      }
      this.setData({ totalValueDisplay: current })
      this._totalValueTimer = setTimeout(step, 16)
    }
    step()
  },

  onHide() {
    // 页面隐藏时停止动画，避免无意义的 setData
    if (this._totalValueTimer) {
      clearTimeout(this._totalValueTimer)
      this._totalValueTimer = null
    }
  },

  // 仅从缓存渲染（不发网络请求）
  _renderItems(animate = false) {
    const rawItems = app.globalData.items
    const alertDays = app.globalData.settings.alertDays

    const items = rawItems.map(item => {
      const daysRemaining = util.calcDaysRemaining(item.expiryDate)
      const status = util.getItemStatus(item.expiryDate, item.alertDays || alertDays)
      const countdownText = util.getCountdownText(item.expiryDate)
      const statusText = util.getStatusText(status)
      const progressPercent = util.calcProgressPercent(item)

      return {
        ...item,
        daysRemaining,
        status,
        countdownText,
        statusText,
        progressPercent,
        expiryDateFormatted: item.expiryDate,
        savedAtText: item.savedAt ? util.formatDate(item.savedAt) : '',
        categoryClass: CATEGORY_CLASS_MAP[item.category] || 'cat-other'
      }
    })

    // 按创建时间排序（最新在前），同创建时间按到期日期升序
    const sorted = util.sortItemsByCreatedAt(items)

    // 分页：计算当前 tab 下的可见列表并打标记
    const visible = this._computeVisible(sorted, this.data.filterTab, this.data.visibleCount)

    this.setData({
      items: visible.markedItems,
      isEmpty: sorted.length === 0,
      listLoadedAll: visible.loadedAll,
      listTotal: visible.total,
      _animateCards: animate,
      loading: false
    })

    // 动画播放一段时间后重置标志，避免后续 setData 重复触发
    if (animate) {
      setTimeout(() => {
        this.setData({ _animateCards: false })
      }, 1500)
    }
  },

  // 切换筛选
  onFilterTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ filterTab: tab, visibleCount: PAGE_SIZE })
    this._refreshDisplay()
  },

  // 按 tab 过滤物品
  _filterByTab(items, tab) {
    switch (tab) {
      case 'safe':
        return items.filter(i => !i.saved && i.status === 'safe')
      case 'warning':
        return items.filter(i => !i.saved && (i.status === 'warning' || i.status === 'danger'))
      case 'expired':
        return items.filter(i => !i.saved && i.status === 'expired')
      case 'saved':
        return items.filter(i => i.saved)
      default:
        return items
    }
  },

  // 计算分页可见列表：过滤 + 截断 + 打 _visible 标记
  _computeVisible(items, tab, count) {
    const filtered = this._filterByTab(items, tab)
    const visibleIds = new Set(filtered.slice(0, count).map(i => i.id))
    return {
      markedItems: items.map(i => ({ ...i, _visible: visibleIds.has(i.id) })),
      // 当前过滤列表已全部展示，且云端已无更多数据
      loadedAll: filtered.length <= count && !this.data.hasMore,
      total: filtered.length
    }
  },

  // 刷新可见列表（切换 tab / 上拉加载更多时调用）
  _refreshDisplay() {
    const { items, filterTab, visibleCount } = this.data
    const visible = this._computeVisible(items, filterTab, visibleCount)
    this.setData({
      items: visible.markedItems,
      listLoadedAll: visible.loadedAll,
      listTotal: visible.total
    })
  },

  // 上拉触底：先展开已拉取数据，再向云端拉下一页
  onReachBottom() {
    if (this.data.loading || this.data.loadingMore || this.data.isEmpty) return

    const { items, filterTab, visibleCount, hasMore } = this.data
    const filtered = this._filterByTab(items, filterTab)

    // 已拉取的数据还没展示完：纯前端展开
    if (visibleCount < filtered.length) {
      this.setData({ visibleCount: visibleCount + PAGE_SIZE })
      this._refreshDisplay()
      return
    }

    // 云端还有更多：拉下一页
    if (hasMore) this._loadMore()
  },

  // 从云端加载下一页
  async _loadMore() {
    this.setData({ loadingMore: true })
    const groupId = app.getBoundGroupId()
    try {
      const { items: pageItems, total } = await syncUtil.fetchItemsPage(
        app.globalData.items.length,
        PAGE_SIZE,
        groupId
      )

      // 合并去重后写回缓存
      const merged = [...app.globalData.items]
      const seen = new Set(merged.map(i => i.id))
      for (const it of pageItems) {
        if (!seen.has(it.id)) {
          merged.push(it)
          seen.add(it.id)
        }
      }
      app.globalData.items = merged

      this.setData({
        visibleCount: this.data.visibleCount + PAGE_SIZE,
        hasMore: merged.length < total,
        totalCount: total
      })
      this._renderItems()
    } catch (err) {
      console.error('加载更多失败:', err)
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
    } finally {
      this.setData({ loadingMore: false })
    }
  },

  // 获取筛选后的列表
  getFilteredItems() {
    return this._filterByTab(this.data.items, this.data.filterTab)
  },

  // 跳转添加
  goAdd() {
    wx.navigateTo({ url: '/pages/add/add' })
  },

  // 跳转排行榜
  goLeaderboard() {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard' })
  },

  // 跳转队伍管理
  goTeam() {
    this.setData({ showSwitcher: false })
    wx.navigateTo({ url: '/pages/team/team' })
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

  // 标记已省钱（Bingo 时刻）
  async onSaveItem(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.items.find(i => i.id === id)
    if (!item || item.saved || item.status === 'expired') return

    const savedValue = parseFloat(item.value) || 0

    wx.showLoading({ title: '标记中...' })
    try {
      await app.updateItem(id, {
        saved: true,
        savedAt: new Date().toISOString()
      })
      // 同步更新 globalData 缓存
      const cached = app.globalData.items.find(i => i.id === id)
      if (cached) {
        cached.saved = true
        cached.savedAt = new Date().toISOString()
      }
      syncUtil.recordSave(savedValue)
      wx.hideLoading()

      // 卡片闪烁动画
      const items = this.data.items.map(i => {
        if (i.id === id) return { ...i, _savingFlash: true }
        return i
      })
      this.setData({ items })

      // 300ms 后刷新列表 + 显示庆祝弹层
      setTimeout(() => {
        this._renderItems()
        this._loadStats()
        this.setData({
          showBingo: true,
          bingoAmount: savedValue,
          bingoItemName: item.name
        })
      }, 300)

      // 2.5 秒后自动关闭
      this._bingoTimer = setTimeout(() => {
        this.dismissBingo()
      }, 2500)
    } catch (err) {
      wx.hideLoading()
      console.error('标记省钱失败:', err)
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  // 关闭庆祝弹层
  dismissBingo() {
    if (this._bingoTimer) {
      clearTimeout(this._bingoTimer)
      this._bingoTimer = null
    }
    this.setData({ showBingo: false })
  },

  // 加载成就横幅文案
  async loadAchievementBanner() {
    try {
      const result = await syncUtil.getLeaderboardStats()
      const data = result.data
      if (!data) return

      const totalSaved = data.totalSaved || 0
      // 已省钱物品的真实价值总和（不再按均价估算）
      const estimatedSaved = data.totalSavedValue || 0
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

  // 等级计算（与 leaderboard 保持一致，mark 用阿拉伯数字避免罗马数字被误读）
  calcLevel(totalSaved) {
    const LEVELS = [
      { min: 0, max: 4, mark: '1', name: '新手守护者' },
      { min: 5, max: 19, mark: '2', name: '过期终结者' },
      { min: 20, max: 49, mark: '3', name: '防腐达人' },
      { min: 50, max: 99, mark: '4', name: '节约大师' },
      { min: 100, max: Infinity, mark: '5', name: '零浪费传奇' }
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
    // 已省钱/已过期/无价值的物品不可左滑（与详情页标记按钮条件一致）
    const item = this.data.items.find(i => i.id === id)
    if (!item || item.saved || item.status === 'expired' || !(item.value > 0)) return
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

          // 记录统计数据：未省钱且未过期 = 避免过期（已省钱物品标记时已记录，避免重复计数）
          const daysRemaining = item.daysRemaining
          if (!item.saved && daysRemaining >= 0) {
            syncUtil.recordSave(item.value || 0)
          } else if (!item.saved) {
            syncUtil.recordExpired()
          }

          wx.hideLoading()
          wx.showToast({ title: '已删除', icon: 'success' })
          this._renderItems()
          this._loadStats()
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
