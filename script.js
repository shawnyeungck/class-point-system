// ==========================================
// CONFIGURATION: GAS API URL
// ==========================================
const API_URL = "https://script.google.com/macros/s/AKfycbyWkt5bTcX8BokqviAXoMgFaWTyU2PkqqeHy-rhGRiJlsWkkn6-wLGfdylDFWLfh-nC/exec";
const API_TIMEOUT_MS = 15000;
const API_MAX_ATTEMPTS = 3;

// ==========================================
// API Call Helper
// ==========================================
async function callApi(action, params = {}) {
  const isReadAction = ['getInitialData', 'getLatestScores'].includes(action);
  let fetchUrl = API_URL;
  let options = { method: "POST" };

  if (isReadAction) {
    // 讀取類操作用 GET，避免 CORS 錯誤
    const queryString = new URLSearchParams({ action: action, ...params }).toString();
    fetchUrl = `${API_URL}?${queryString}`;
    options.method = "GET";
  } else {
    // 寫入類操作用 POST
    const payload = { action: action, ...params };
    options.body = JSON.stringify(payload);
  }

  const maxAttempts = isReadAction ? API_MAX_ATTEMPTS : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchWithTimeout(fetchUrl, options, API_TIMEOUT_MS);
      const text = await response.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (parseError) {
          throw buildApiError(action, response.status, "API 回傳不是有效 JSON");
        }
      }
      if (!response.ok) {
        throw buildApiError(action, response.status, data.error || data.message || response.statusText || "HTTP 錯誤");
      }
      if (data.error || data.status === 'error') throw buildApiError(action, response.status, data.error || data.message || "API 回傳錯誤");
      return data;
    } catch (error) {
      lastError = error;
      const canRetry = isReadAction && attempt < maxAttempts && (!error.httpStatus || error.httpStatus >= 500);
      if (!canRetry) break;
      await delay(700 * attempt);
    }
  }
  throw lastError || buildApiError(action, 0, "未知連線錯誤");
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .finally(() => clearTimeout(timer));
}

function buildApiError(action, httpStatus, message) {
  const error = new Error(`API ${action} 失敗${httpStatus ? ` (HTTP ${httpStatus})` : ""}：${message}`);
  error.httpStatus = httpStatus;
  return error;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// Global Variables
// ==========================================
let allStudents = [], originalStudents = [], teacherList = [], allItems = [], allGroups = [], allGifts = [];
let titleConfig = { enabled: false, rules: [] }, allLogs = [], monthlyKings = [], allVerses = [], appSettings = {};
let currentTeacher = null, isSorted = false;
let modalTargetType = "", modalTargetName = "", currentScoreCategory = "加分", currentFilter = "all";
let batchExcludedSet = new Set();
const studentScoreMap = {};
let progressInterval;
const loadingOverlay = document.getElementById('loadingOverlay');
const progressBar = document.getElementById('progressBar');

// Feature Variables
let luckyIntervalId = null, currentGroupStudents = [], activeCandidates = [], excludedNames = new Set(), currentLuckyStudent = null;
const HISTORY_PER_PAGE = 5; 
let currentHistoryPage = 1, currentModalStudent = null;
let currentDiceMax = 6, isRolling = false;
let timerInterval = null, totalSeconds = 0, isTimerRunning = false;
const alarmSound = new Audio("https://actions.google.com/sounds/v1/alarms/beep_short.ogg"); 
alarmSound.loop = true;

// ==========================================
// Initialization
// ==========================================
window.onload = function() {
  startLoadingSimulation();
  callApi('getInitialData')
    .then(data => {
      finishLoading();
      if (!data) throw new Error("無資料");
      
      // Data assignment
      allStudents = data.students || [];
      originalStudents = [...allStudents];
      teacherList = data.teachers || [];
      allItems = data.items || [];
      allGroups = data.groups || [];
      allGifts = data.gifts || [];
      titleConfig = data.titles || { enabled: false, rules: [] };
      allLogs = data.logs || [];
      monthlyKings = data.monthlyKings || [];
      allVerses = data.bibleVerses || [];
      appSettings = data.settings || {};

      generateFilterButtons();
      renderPage();
      
      if (document.getElementById('filterContainer')) {
        document.getElementById('filterContainer').style.display = 'flex';
      }
    })
    .catch(error => {
      clearInterval(progressInterval);
      updateProgressBar(100);
      alert("資料載入失敗：" + error.message);
      finishLoading();
    });
};

function renderPage() {
  renderStudents();
  renderGroups();
  renderGifts();
  renderTitles();
  initLogFilter();
  renderMarquee();
  
  if (currentTeacher) {
    document.getElementById('displayTeacherName').textContent = currentTeacher['姓名'];
    document.querySelector('.teacher-info').style.display = 'block';
    document.getElementById('loginButton').style.display = 'none';
    document.getElementById('logoutButton').style.display = 'inline-flex';
  } else {
    document.querySelector('.teacher-info').style.display = 'none';
    document.getElementById('loginButton').style.display = 'inline-flex';
    document.getElementById('logoutButton').style.display = 'none';
  }
}

// ==========================================
// Core Rendering Logic
// ==========================================
function generateFilterButtons() {
  const filterContainer = document.getElementById('filterContainer');
  if (!filterContainer) return;
  filterContainer.innerHTML = '';
  
  const allBtn = document.createElement('button');
  allBtn.className = 'filter-btn active';
  allBtn.textContent = '全部';
  allBtn.onclick = () => filterStudents('all', allBtn);
  filterContainer.appendChild(allBtn);
  
  allGroups.forEach(groupName => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.textContent = groupName;
    btn.onclick = () => filterStudents(groupName, btn);
    filterContainer.appendChild(btn);
  });
}

function filterStudents(groupName, btnElement) {
  currentFilter = groupName;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btnElement.classList.add('active');
  renderStudents();
}

function renderStudents() {
  const container = document.getElementById('studentSection');
  if (!container) return;
  container.innerHTML = '';
  
  const groupRankMap = getGroupRankings(allStudents);
  let studentsToRender = isSorted ? allStudents : originalStudents;
  if (currentFilter !== 'all') {
    studentsToRender = studentsToRender.filter(s => String(s["分組"]).trim() === currentFilter);
  }

  studentsToRender.forEach(stu => {
    const score = Number(stu["總得分"]) || 0;
    const cumulativeScore = Number(stu["累積分數"]) || 0;
    const groupName = String(stu["分組"]).trim() || "未分組";
    const imgUrl = (stu["圖片網址"] && String(stu["圖片網址"]).trim() !== '') ? stu["圖片網址"] : '';

    let titleHtml = '', kingHtml = '', frameClass = '', effectClass = '';
    
    if (titleConfig.enabled && titleConfig.rules.length > 0) {
      const sortedRules = [...titleConfig.rules].sort((a, b) => Number(b.score) - Number(a.score));
      for (const rule of sortedRules) {
        if (cumulativeScore >= Number(rule.score)) {
          titleHtml = `<div class="info-pill title-pill">(${rule.score}) ${rule.title}</div>`;
          break;
        }
      }
    }
    
    if (monthlyKings.includes(stu["姓名"])) {
      kingHtml = `<div class="king-pill">👑 本月得分王！</div>`;
      effectClass = 'effect-king';
    }
    
    if (cumulativeScore >= 80) frameClass = 'frame-gold';
    else if (cumulativeScore >= 35) frameClass = 'frame-silver';
    else if (cumulativeScore >= 20) frameClass = 'frame-bronze';

    const myRank = groupRankMap[stu["姓名"]];
    let medalHtml = '';
    if (myRank === 1) medalHtml = getMedalHtml('gold', stu["姓名"], groupName, cumulativeScore, imgUrl);
    else if (myRank === 2) medalHtml = getMedalHtml('silver', stu["姓名"], groupName, cumulativeScore, imgUrl);
    else if (myRank === 3) medalHtml = getMedalHtml('bronze', stu["姓名"], groupName, cumulativeScore, imgUrl);

    const wrapper = document.createElement('div');
    wrapper.className = "student-card-wrapper";
    const card = document.createElement('div');
    card.className = "student-card";
    
    let imageContent = imgUrl 
      ? `<div class="image-container ${frameClass} ${effectClass}"><img src="${imgUrl}" alt="${stu["姓名"]}" onerror="handleImageError(this)">${medalHtml}</div>`
      : `<div class="image-container ${frameClass} ${effectClass}"><div class="student-square" style="background:${generateRandomPastelColor()};"></div>${medalHtml}</div>`;
    
    card.innerHTML = `
      ${imageContent}
      <div class="stats-row">
        <div class="score-pill"><span>🌟</span> ${score}</div>
        <div class="cumulative-pill"><span>💡</span> ${cumulativeScore}</div>
      </div>
      <div class="info-container">
        ${kingHtml}
        ${titleHtml}
        <div class="info-pill student-name-pill">${stu["姓名"]}</div>
        <div class="info-pill group-name-pill">${groupName}</div>
      </div>
    `;
    card.onclick = () => openScoreModal("學生", stu["姓名"]);
    wrapper.appendChild(card);
    container.appendChild(wrapper);
    studentScoreMap[stu["姓名"]] = card.querySelector(".score-pill");
  });
}

function renderGroups() {
  const container = document.getElementById('groupSection');
  if (!container) return;
  container.innerHTML = '';
  const gradients = ['linear-gradient(135deg, #FF6B6B, #FFA07A)', 'linear-gradient(135deg, #4ECDC4, #A0D8D4)', 'linear-gradient(135deg, #4F80E1, #80A7F5)', 'linear-gradient(135deg, #8A2BE2, #B98BEF)', 'linear-gradient(135deg, #FFD700, #FFEE79)', 'linear-gradient(135deg, #3CB371, #8FD4AA)'];
  
  allGroups.forEach((groupName, index) => {
    const studentsInGroup = allStudents.filter(s => String(s["分組"]).trim() === groupName);
    const studentsStr = studentsInGroup.map(s => s["姓名"]).join('、');
    const groupBtn = document.createElement('div');
    groupBtn.className = "group-button";
    groupBtn.style.background = gradients[index % gradients.length];
    groupBtn.innerHTML = `<div class="group-name">${groupName}</div><div class="group-students">${studentsStr}</div>`;
    groupBtn.onclick = () => openScoreModal("小組", groupName);
    
    const wrapper = document.createElement('div');
    wrapper.className = "student-card-wrapper";
    wrapper.appendChild(groupBtn);
    container.appendChild(wrapper);
  });
}

function renderGifts() {
  const container = document.getElementById('giftSection');
  if (!container) return;
  container.innerHTML = '';
  const tiers = [
    { name: "秀才賞", range: "5分或以下", min: -9999, max: 5, color: "var(--tier1-color)" },
    { name: "探花賞", range: "6至25分", min: 6, max: 25, color: "var(--tier2-color)" },
    { name: "榜眼賞", range: "26至40分", min: 26, max: 40, color: "var(--tier3-color)" },
    { name: "狀元賞", range: "41至85分", min: 41, max: 85, color: "var(--tier4-color)" },
    { name: "金榜之首", range: "86分以上", min: 86, max: 99999, color: "var(--tier5-color)" }
  ];
  
  tiers.forEach(tier => {
    let tierGifts = allGifts.filter(g => { const s = Number(g["所需分數"]) || 0; return s >= tier.min && s <= tier.max; });
    tierGifts.sort((a, b) => {
      const qtyA = (a["數量"] === "" || a["數量"] === undefined) ? 999 : Number(a["數量"]);
      const qtyB = (b["數量"] === "" || b["數量"] === undefined) ? 999 : Number(b["數量"]);
      if (qtyA === 0 && qtyB !== 0) return 1;
      if (qtyA !== 0 && qtyB === 0) return -1;
      return (Number(a["所需分數"]) || 0) - (Number(b["所需分數"]) || 0);
    });
    
    const rowDiv = document.createElement('div');
    rowDiv.className = 'gift-row';
    rowDiv.innerHTML = `<div class="gift-category-label" style="background:${tier.color}"><span class="gift-label-title">${tier.name}</span><span class="gift-label-desc">${tier.range}</span></div>`;
    const listDiv = document.createElement('div');
    listDiv.className = 'gift-list-container';
    
    if (tierGifts.length === 0) {
      listDiv.innerHTML = '<div style="padding:10px; opacity:0.5;">暫無禮物</div>';
    } else {
      tierGifts.forEach(gift => {
        const qty = (gift["數量"] === "" || gift["數量"] === undefined) ? 999 : Number(gift["數量"]);
        const isSoldOut = (qty === 0);
        const imgUrl = gift["圖片連結"] || '';
        const imgTag = imgUrl 
          ? `<img src="${imgUrl}" class="gift-img" onclick="openImageModal('${imgUrl}')">` 
          : `<div class="gift-img d-flex align-items-center justify-content-center" style="background:#eee;border-radius:10px;"><i class="fas fa-gift fa-3x text-secondary"></i></div>`;
        const overlay = isSoldOut ? `<div class="sold-out-overlay"><div class="sold-out-stamp">缺貨！</div></div>` : '';
        
        const card = document.createElement('div');
        card.className = 'gift-card';
        card.innerHTML = `<div class="sold-out-wrapper">${imgTag}${overlay}</div><div class="gift-name">${gift["禮物名稱"]}</div><div class="gift-point-pill">${gift["所需分數"]} 分</div>`;
        listDiv.appendChild(card);
      });
    }
    rowDiv.appendChild(listDiv);
    container.appendChild(rowDiv);
  });
}

function renderTitles() {
  const container = document.getElementById('titleSection');
  if (!container) return;
  container.innerHTML = '';
  const rules = (titleConfig && titleConfig.rules) ? titleConfig.rules : [];
  if (rules.length === 0) {
    container.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:20px; color:#555;">暫無稱號資料</div>';
    return;
  }
  
  const holdersMap = {};
  const sortedRulesForCalc = [...rules].sort((a, b) => Number(b.score) - Number(a.score));
  allStudents.forEach(stu => {
    const cScore = Number(stu["累積分數"]) || 0;
    const matchedRule = sortedRulesForCalc.find(r => cScore >= Number(r.score));
    if (matchedRule) {
      if (!holdersMap[matchedRule.title]) holdersMap[matchedRule.title] = [];
      holdersMap[matchedRule.title].push(stu["姓名"]);
    }
  });

  rules.sort((a, b) => (Number(a.score) || 0) - (Number(b.score) || 0));
  rules.forEach(rule => {
    const wrapper = document.createElement('div');
    wrapper.className = "student-card-wrapper";
    const card = document.createElement('div');
    card.className = "title-card";
    
    let holdersHtml = '';
    const holders = holdersMap[rule.title] || [];
    if (holders.length > 0) {
      holders.sort((a, b) => a.localeCompare(b));
      const listItems = holders.map(name => `<span class="title-holder-badge">${name}</span>`).join('');
      holdersHtml = `<div class="title-holders-list">${listItems}</div>`;
    }
    
    card.innerHTML = `<div class="title-score-badge">🏆 積分 ${rule.score}</div><div class="title-name-large">${rule.title}</div><div class="title-holders-section"><span class="title-holders-label">目前擁有者：</span>${holdersHtml}</div>`;
    wrapper.appendChild(card);
    container.appendChild(wrapper);
  });
}

function initLogFilter() {
  const groupSel = document.getElementById('logGroupSelect');
  const studentSel = document.getElementById('logFilterSelect');
  if (!groupSel || !studentSel) return;
  
  groupSel.innerHTML = '<option value="all">全部組別</option>';
  [...allGroups].sort().forEach(g => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    groupSel.appendChild(opt);
  });
  updateLogStudentOptions('all');
}

function onLogGroupChange() {
  updateLogStudentOptions(document.getElementById('logGroupSelect').value);
  filterLogs();
}

function updateLogStudentOptions(groupName) {
  const studentSel = document.getElementById('logFilterSelect');
  studentSel.innerHTML = '<option value="all">全部學生</option>';
  let targetStudents = allStudents;
  if (groupName !== 'all') targetStudents = allStudents.filter(s => String(s["分組"]).trim() === groupName);
  targetStudents.sort((a, b) => a['姓名'].localeCompare(b['姓名']));
  targetStudents.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s['姓名'];
    opt.textContent = s['姓名'];
    studentSel.appendChild(opt);
  });
}

function filterLogs() {
  renderLogs(document.getElementById('logGroupSelect').value, document.getElementById('logFilterSelect').value);
}

function renderLogs(groupFilter = 'all', studentFilter = 'all') {
  const tbody = document.getElementById('logTableBody');
  tbody.innerHTML = '';
  
  let logsToShow = allLogs.filter(log => {
    const studentInfo = allStudents.find(s => s["姓名"] === log.student);
    const studentGroup = studentInfo ? String(studentInfo["分組"]).trim() : "未分組";
    return ((groupFilter === 'all') || (studentGroup === groupFilter)) && ((studentFilter === 'all') || (log.student === studentFilter));
  });

  if (logsToShow.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted p-4">沒有符合條件的記錄</td></tr>';
    return;
  }
  
  logsToShow.forEach(log => {
    const tr = document.createElement('tr');
    const date = new Date(log.time);
    const timeStr = date.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const teacherObj = teacherList.find(t => t['帳號'] === log.teacherAcc);
    const teacherName = teacherObj ? teacherObj['姓名'] : log.teacherAcc;
    const scoreNum = Number(log.score);
    const scoreClass = scoreNum > 0 ? 'log-score positive' : 'log-score';
    
    let editBtnHtml = '';
    if (currentTeacher) {
      // 這裡將 item (項目名稱) 也傳入 openEditLogModal
      editBtnHtml = `<button class="btn btn-sm btn-outline-secondary ms-2" style="border-radius:50%;padding:2px 6px" onclick="openEditLogModal(${log.rowIndex}, '${log.student}', ${scoreNum}, '${log.item}')"><i class="fas fa-pen" style="font-size:0.7rem"></i></button>`;
    }

    tr.innerHTML = `<td class="log-time">${timeStr}</td><td style="font-weight:bold;">${log.student}</td><td>${teacherName}</td><td>${log.item}</td><td class="${scoreClass}">${scoreNum > 0 ? '+' : ''}${scoreNum}${editBtnHtml}</td>`;
    tbody.appendChild(tr);
  });
}

function renderMarquee() {
  const container = document.getElementById('marqueeContainer');
  const content = document.getElementById('marqueeContent');
  if (!container || !content) return;
  if (!allLogs || allLogs.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  let html = '';
  allLogs.slice(0, 15).forEach(log => {
    const date = new Date(log.time);
    const timeStr = date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
    const scoreNum = Number(log.score);
    const scoreClass = scoreNum >= 0 ? 'text-success' : 'text-danger';
    html += `<span class="marquee-item"><span class="text-muted small me-1">[${timeStr}]</span><strong>${log.student}</strong><span class="${scoreClass} fw-bold ms-1">${scoreNum >= 0 ? '+' : ''}${scoreNum}</span> <span class="text-muted">(${log.item})</span></span>`;
  });
  content.innerHTML = html;
}

// ==========================================
// Action Handlers
// ==========================================
function updateScores() {
  const btn = document.getElementById('updateScoresButton');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  callApi('getInitialData')
    .then(data => {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-sync-alt"></i> 更新';
      if (data.students) allStudents = data.students;
      if (data.logs) allLogs = data.logs;
      if (data.monthlyKings) monthlyKings = data.monthlyKings;
      
      if (isSorted) allStudents.sort((a, b) => (b["累積分數"] || 0) - (a["累積分數"] || 0));
      renderPage();
    })
    .catch(e => {
      alert("更新失敗: " + e);
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-sync-alt"></i> 更新';
    });
}

function sendScoreRecord() {
  const item = document.getElementById('itemSelect').value;
  let score = document.getElementById('scoreSelect').value;
  if (score === 'custom') {
    score = document.getElementById('customScoreInput').value;
    if (!score || score <= 0) {
      alert("請輸入有效的正整數！");
      return;
    }
  }
  
  let finalTargetType = modalTargetType, finalTargetName = modalTargetName;
  if (modalTargetType === "小組") {
    const groupStudents = allStudents.filter(s => String(s["分組"]).trim() === modalTargetName);
    if (batchExcludedSet.size === groupStudents.length) {
      alert("請至少選擇一位學生！");
      return;
    }
    if (batchExcludedSet.size > 0) {
      finalTargetType = "自訂名單";
      finalTargetName = groupStudents.map(s => s["姓名"]).filter(name => !batchExcludedSet.has(name)).join(",");
    }
  }
  
  const btn = document.getElementById('confirmScoreBtn');
  btn.disabled = true;
  btn.innerHTML = "傳送中...";
  
  callApi('addScoreRecord', { teacherAccount: currentTeacher["帳號"], targetType: finalTargetType, targetName: finalTargetName, item: item, score: score })
    .then(data => {
      closeScoreModal();
      btn.disabled = false;
      btn.innerHTML = "送出";
      
      if (data.students) allStudents = data.students;
      if (data.logs) allLogs = data.logs;
      if (data.monthlyKings) monthlyKings = data.monthlyKings;

      if (isSorted) allStudents.sort((a, b) => (b["累積分數"] || 0) - (a["累積分數"] || 0));
      renderPage();
    })
    .catch(e => {
      alert("錯誤：" + e);
      btn.disabled = false;
      btn.innerHTML = "送出";
    });
}

function loginTeacher() {
  const acc = document.getElementById('loginAccount').value.trim();
  const pwd = document.getElementById('loginPassword').value.trim();
  const t = teacherList.find(x => String(x['帳號']) === acc && String(x['密碼']) === pwd);
  if (t) {
    currentTeacher = t;
    hideLoginOverlay();
    renderPage();
    if (document.querySelector('.nav-link.active').dataset.type === 'log') {
      filterLogs();
    }
  } else {
    alert("帳號或密碼錯誤");
  }
}

function logoutTeacher() {
  currentTeacher = null;
  isSorted = false;
  document.getElementById('sortScoresButton').innerHTML = '<i class="fas fa-sort-amount-down"></i> 排序';
  renderPage();
}

function switchCategory(type) {
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const activeTab = document.querySelector(`[data-type="${type}"]`);
  if (activeTab) activeTab.classList.add('active');
  
  ['student', 'group', 'gift', 'title', 'log', 'luckydraw', 'dice', 'bible'].forEach(k => {
    const el = document.getElementById(k + 'Container');
    if (el) el.style.display = (k === type) ? 'block' : 'none';
  });
  
  if (type === 'student') {
    document.getElementById('filterContainer').style.display = 'flex';
    renderStudents();
  } else {
    document.getElementById('filterContainer').style.display = 'none';
  }
  
  if (type === 'group') renderGroups();
  if (type === 'gift') renderGifts();
  if (type === 'title') renderTitles();
  if (type === 'log') filterLogs();
  if (type === 'luckydraw') initLuckyDraw();
  if (type === 'bible') renderBibleVerses();
  
  const sortBtn = document.getElementById('sortScoresButton');
  if (sortBtn) sortBtn.style.visibility = (type === 'student' || type === 'group') ? 'visible' : 'hidden';
}

// ==========================================
// Helper Logic
// ==========================================
function openScoreModal(type, name) {
  modalTargetType = type;
  modalTargetName = name;
  const infoEl = document.getElementById('modalTargetInfo');
  if (infoEl) infoEl.textContent = `${type}：${name}`;
  
  const batchContainer = document.getElementById('groupBatchSelector');
  if (batchContainer) batchContainer.style.display = 'none';
  const xpContainer = document.getElementById('xpContainer');
  if (xpContainer) xpContainer.style.display = 'none';
  document.getElementById('historyContainer').style.display = 'none';

  if (type === "學生") {
    updateLevelProgress(name);
    currentModalStudent = name;
    currentHistoryPage = 1;
    renderStudentHistory(name);
  } else if (type === "小組") {
    if (batchContainer) {
      batchContainer.style.display = 'block';
      renderBatchSelector(name);
    }
  }
  
  const teacherArea = document.getElementById('teacherControls');
  const confirmBtn = document.getElementById('confirmScoreBtn');
  const modalTitle = document.getElementById('scoreModalLabel');
  
  if (teacherArea && confirmBtn) {
    if (currentTeacher) {
      teacherArea.style.display = 'block';
      confirmBtn.style.display = 'inline-block';
      if (modalTitle) modalTitle.textContent = "✨ 加扣分操作";
      setScoreCategory("加分");
    } else {
      teacherArea.style.display = 'none';
      confirmBtn.style.display = 'none';
      if (modalTitle) modalTitle.textContent = "🎓 學生等級資訊";
    }
  }
  new bootstrap.Modal(document.getElementById('scoreModal')).show();
}

function updateLevelProgress(studentName) {
  const xpContainer = document.getElementById('xpContainer'), xpText = document.getElementById('xpText'), xpBar = document.getElementById('xpBar'), monthlyText = document.getElementById('monthlyScoreText');
  const student = allStudents.find(s => s["姓名"] === studentName);
  if (!student || !titleConfig.enabled || !titleConfig.rules || titleConfig.rules.length === 0) return;
  const currentScore = Number(student["累積分數"]) || 0;
  const monthScore = Number(student["本月得分"]) || 0;
  const rules = [...titleConfig.rules].sort((a, b) => Number(a.score) - Number(b.score));
  let currentTitleObj = { score: 0, title: "無稱號" }, nextTitleObj = null;
  for (let i = 0; i < rules.length; i++) {
    if (currentScore >= Number(rules[i].score)) currentTitleObj = rules[i];
    else { nextTitleObj = rules[i]; break; }
  }
  
  xpContainer.style.display = 'block';
  if (nextTitleObj) {
    const range = Number(nextTitleObj.score) - Number(currentTitleObj.score);
    const percent = Math.min(100, Math.max(0, ((currentScore - Number(currentTitleObj.score)) / range) * 100));
    xpBar.style.width = `${percent}%`;
    xpText.innerHTML = `目前: <strong>${currentTitleObj.title}</strong> (${currentScore}) <br><span class="text-primary">下一級還差 ${Number(nextTitleObj.score) - currentScore} 分</span>`;
  } else {
    xpBar.style.width = '100%';
    xpText.innerHTML = `目前: <strong>${currentTitleObj.title}</strong> (${currentScore})<br>🎉 已達最高等級！`;
  }
  if (monthlyText) {
    let htmlContent = `📅 本月累積：<span class="text-danger fw-bold">${monthScore}</span> 分`;
    const myGroup = String(student["分組"]).trim();
    let maxInGroup = -1, leaderName = "";
    allStudents.forEach(s => {
      if (String(s["分組"]).trim() === myGroup) {
        const sMonthScore = Number(s["本月得分"]) || 0;
        if (sMonthScore > maxInGroup) { maxInGroup = sMonthScore; leaderName = s["姓名"]; }
      }
    });
    if (maxInGroup <= 0) htmlContent += ` (本月戰鬥剛開始)`;
    else if (monthScore >= maxInGroup) htmlContent += ` <span class="badge bg-warning text-dark">👑 組內第一</span>`;
    else htmlContent += ` (落後 ${leaderName} ${maxInGroup - monthScore} 分)`;
    monthlyText.innerHTML = htmlContent;
  }
}

// --- Edit Log Logic (Including Item Name) ---
function openEditLogModal(rowIndex, name, score, item) {
  document.getElementById('editLogRowIndex').value = rowIndex;
  document.getElementById('editLogName').value = name;
  document.getElementById('editLogScore').value = score;
  document.getElementById('editLogItem').value = item;
  new bootstrap.Modal(document.getElementById('editLogModal')).show();
}

function doEditLog() {
  const r = document.getElementById('editLogRowIndex').value;
  const n = document.getElementById('editLogName').value;
  const s = document.getElementById('editLogScore').value;
  const i = document.getElementById('editLogItem').value;
  if (!n || !s || !i) { alert("請填寫完整"); return; }
  const btn = document.querySelector('#editLogModal .btn-primary');
  btn.disabled = true;
  btn.innerHTML = "儲存中...";
  callApi('editLogRecord', { rowIndex: r, newName: n, newScore: s, newItem: i })
    .then(data => {
      allStudents = data.students || [];
      allLogs = data.logs || [];
      monthlyKings = data.monthlyKings || [];
      bootstrap.Modal.getInstance(document.getElementById('editLogModal')).hide();
      btn.disabled = false;
      btn.innerHTML = "儲存修改";
      renderPage();
      renderStudents();
      alert("修改成功！");
    })
    .catch(e => {
      alert("失敗: " + e.message);
      btn.disabled = false;
      btn.innerHTML = "儲存修改";
    });
}

// --- Lucky Draw Logic ---
function initLuckyDraw() {
  const container = document.getElementById('luckyGroupSelector');
  container.innerHTML = '';
  [...allGroups].sort().forEach((group, index) => {
    const btn = document.createElement('button');
    btn.className = 'modern-btn lucky-group-btn';
    btn.textContent = group;
    btn.onclick = () => selectLuckyGroup(group, btn);
    container.appendChild(btn);
    if (index === 0) selectLuckyGroup(group, btn);
  });
}

function selectLuckyGroup(groupName, btnElement) {
  if (btnElement) {
    document.querySelectorAll('.lucky-group-btn').forEach(b => b.classList.remove('active'));
    btnElement.classList.add('active');
  }
  currentGroupStudents = allStudents.filter(s => String(s["分組"]).trim() === groupName);
  excludedNames.clear();
  renderExclusionList();
  updateActiveCandidates();
  resetLuckyCard();
}

function renderExclusionList() {
  const list = document.getElementById('exclusionList');
  list.innerHTML = '';
  currentGroupStudents.forEach(stu => {
    const item = document.createElement('div');
    item.className = 'exclusion-item';
    item.onclick = () => toggleExclusion(stu["姓名"], item);
    let imgHtml = stu["圖片網址"] ? `<img src="${stu["圖片網址"]}">` : `<div class="placeholder"><i class="fas fa-user"></i></div>`;
    item.innerHTML = `${imgHtml}<span>${stu["姓名"]}</span>`;
    list.appendChild(item);
  });
}

function toggleExclusion(name, domElement) {
  if (luckyIntervalId) return;
  if (excludedNames.has(name)) {
    excludedNames.delete(name);
    domElement.classList.remove('excluded');
  } else {
    excludedNames.add(name);
    domElement.classList.add('excluded');
  }
  updateActiveCandidates();
}

function resetExclusion() {
  if (luckyIntervalId) return;
  excludedNames.clear();
  document.querySelectorAll('.exclusion-item').forEach(el => el.classList.remove('excluded'));
  updateActiveCandidates();
}

function updateActiveCandidates() {
  activeCandidates = currentGroupStudents.filter(s => !excludedNames.has(s["姓名"]));
  const disabled = activeCandidates.length === 0;
  document.getElementById('startLuckyBtn').disabled = disabled;
  document.getElementById('autoLuckyBtn').disabled = disabled;
  document.getElementById('luckyName').textContent = disabled ? "名單為空" : (luckyIntervalId ? document.getElementById('luckyName').textContent : `共 ${activeCandidates.length} 人待命`);
}

function toggleLuckyDrawManual() {
  const btn = document.getElementById('startLuckyBtn'), autoBtn = document.getElementById('autoLuckyBtn');
  if (luckyIntervalId) {
    stopAnimation();
    btn.innerHTML = '再抽一次';
    autoBtn.disabled = false;
  } else {
    if (activeCandidates.length === 0) return;
    startAnimation();
    btn.innerHTML = '停止';
    autoBtn.disabled = true;
  }
}

function startAutoLuckyDraw() {
  if (activeCandidates.length === 0) return;
  const manualBtn = document.getElementById('startLuckyBtn'), autoBtn = document.getElementById('autoLuckyBtn');
  manualBtn.disabled = true;
  autoBtn.disabled = true;
  autoBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  startAnimation();
  setTimeout(() => {
    stopAnimation();
    manualBtn.disabled = false;
    autoBtn.disabled = false;
    autoBtn.innerHTML = '電腦搞珠';
    manualBtn.innerHTML = '手動開始';
  }, Math.floor(Math.random() * 3000) + 2000);
}

function startAnimation() {
  const card = document.getElementById('luckyCard');
  card.classList.add('lucky-jumping');
  document.getElementById('luckyDefaultIcon').style.display = 'none';
  document.getElementById('luckyImage').style.display = 'block';
  luckyIntervalId = setInterval(() => {
    const student = activeCandidates[Math.floor(Math.random() * activeCandidates.length)];
    currentLuckyStudent = student;
    updateLuckyCardDisplay(student);
  }, 80);
}

function stopAnimation() {
  clearInterval(luckyIntervalId);
  luckyIntervalId = null;
  document.getElementById('luckyCard').classList.remove('lucky-jumping');
  if (currentLuckyStudent) openScoreModal("學生", currentLuckyStudent["姓名"]);
}

function updateLuckyCardDisplay(student) {
  document.getElementById('luckyName').textContent = student["姓名"];
  if (student["圖片網址"]) {
    document.getElementById('luckyImage').src = student["圖片網址"];
    document.getElementById('luckyImage').style.display = 'block';
    document.getElementById('luckyDefaultIcon').style.display = 'none';
  } else {
    document.getElementById('luckyImage').style.display = 'none';
    document.getElementById('luckyDefaultIcon').style.display = 'block';
  }
}

function resetLuckyCard() {
  document.getElementById('luckyImage').style.display = 'none';
  document.getElementById('luckyDefaultIcon').style.display = 'block';
  document.getElementById('luckyName').textContent = "誰是幸運兒？";
  document.getElementById('luckyCard').classList.remove('lucky-jumping');
  document.getElementById('startLuckyBtn').innerHTML = '手動開始';
  currentLuckyStudent = null;
}

// --- Dice Logic ---
function selectDiceType(sides) {
  if (isRolling) return;
  currentDiceMax = sides;
  document.getElementById('selDice6').classList.toggle('active', sides === 6);
  document.getElementById('selDice20').classList.toggle('active', sides === 20);
  const diceDisplay = document.getElementById('diceDisplay'), resultSpan = document.getElementById('diceResult');
  resultSpan.innerText = "?";
  if (sides === 6) {
    diceDisplay.classList.remove('dice-d20');
    diceDisplay.classList.add('dice-d6');
  } else {
    diceDisplay.classList.remove('dice-d6');
    diceDisplay.classList.add('dice-d20');
  }
}

function rollDice() {
  if (isRolling) return;
  isRolling = true;
  const diceDisplay = document.getElementById('diceDisplay'), resultSpan = document.getElementById('diceResult');
  diceDisplay.classList.add('dice-shaking');
  resultSpan.classList.remove('dice-pop');
  let tempInterval = setInterval(() => {
    resultSpan.innerText = Math.floor(Math.random() * currentDiceMax) + 1;
  }, 80);
  setTimeout(() => {
    clearInterval(tempInterval);
    diceDisplay.classList.remove('dice-shaking');
    resultSpan.innerText = Math.floor(Math.random() * currentDiceMax) + 1;
    resultSpan.classList.add('dice-pop');
    isRolling = false;
  }, 1500);
}

// --- Bible Logic ---
function renderBibleVerses() {
  const currentContainer = document.getElementById('currentVerseCard'), listContainer = document.getElementById('bibleList');
  if (!currentContainer || !listContainer || !allVerses) return;
  currentContainer.innerHTML = '';
  listContainer.innerHTML = '';
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let currentVerse = null, otherVerses = [];
  const sortedVerses = [...allVerses].sort((a, b) => new Date(b["開始日期"]) - new Date(a["開始日期"]));
  for (const v of sortedVerses) {
    const sDateObj = new Date(v["開始日期"]), eDateObj = new Date(v["結束日期"]);
    if (isNaN(sDateObj) || isNaN(eDateObj)) continue;
    sDateObj.setHours(0, 0, 0, 0);
    eDateObj.setHours(23, 59, 59, 999);
    if (!currentVerse && ((now >= sDateObj && now <= eDateObj) || String(v["高亮提示本週金句"] || "").trim() !== "")) currentVerse = v;
    else otherVerses.push(v);
  }
  if (currentVerse) {
    currentContainer.innerHTML = `<div class="bible-card-main"><div class="badge bg-warning text-dark mb-2">${currentVerse["開始日期"]} ~ ${currentVerse["結束日期"]}</div><div class="bible-text-large">${currentVerse["經文"]}</div><div class="bible-ref-large">${currentVerse["出處"]}</div></div>`;
  } else currentContainer.innerHTML = `<div class="bible-card-main opacity-75"><h4 class="text-muted">本週暫無指定金句</h4></div>`;
  if (otherVerses.length === 0) listContainer.innerHTML = '<div class="text-center text-muted w-100 py-4">暫無歷史金句</div>';
  else {
    otherVerses.forEach(v => {
      const col = document.createElement('div');
      col.className = 'col-md-6 col-lg-4';
      col.innerHTML = `<div class="bible-card-sm"><div class="small text-muted mb-2">${v["開始日期"]} ~ ${v["結束日期"]}</div><div class="bible-text-sm">${v["經文"]}</div><div class="bible-ref-sm">— ${v["出處"]}</div></div>`;
      listContainer.appendChild(col);
    });
  }
}

// --- Timer Logic ---
function toggleTimerPanel() {
  const panel = document.getElementById('timerPanel');
  if (window.getComputedStyle(panel).display === 'none') {
    panel.style.display = 'flex';
    stopAlarm();
  } else {
    panel.style.display = 'none';
    stopTimer();
    stopAlarm();
  }
}

function applyCustomTime() {
  let m = parseInt(document.getElementById('timerInputMin').value) || 0;
  let s = parseInt(document.getElementById('timerInputSec').value) || 0;
  stopTimer();
  stopAlarm();
  totalSeconds = (m * 60) + s;
  updateTimerDisplay();
}

function addTime(minutes) {
  stopAlarm();
  if (isTimerRunning) stopTimer();
  totalSeconds += minutes * 60;
  updateTimerDisplay();
  document.getElementById('timerInputMin').value = Math.floor(totalSeconds / 60);
  document.getElementById('timerInputSec').value = totalSeconds % 60;
}

function resetTimer() {
  stopTimer();
  stopAlarm();
  totalSeconds = 0;
  updateTimerDisplay();
  document.getElementById('timerInputMin').value = '';
  document.getElementById('timerInputSec').value = '';
}

function startTimer() {
  if (totalSeconds === 0) applyCustomTime();
  if (totalSeconds <= 0) {
    alert("請先輸入時間！");
    return;
  }
  if (isTimerRunning) return;
  alarmSound.play().then(() => alarmSound.pause()).catch(() => {});
  isTimerRunning = true;
  document.getElementById('btnStartTimer').style.display = 'none';
  document.getElementById('btnPauseTimer').style.display = 'inline-block';
  timerInterval = setInterval(() => {
    if (totalSeconds > 0) {
      totalSeconds--;
      updateTimerDisplay();
    } else timeIsUp();
  }, 1000);
}

function stopTimer() {
  isTimerRunning = false;
  clearInterval(timerInterval);
  document.getElementById('btnStartTimer').style.display = 'inline-block';
  document.getElementById('btnPauseTimer').style.display = 'none';
}

function updateTimerDisplay() {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  document.getElementById('timerDisplay').textContent = `${m < 10 ? "0" + m : m}:${s < 10 ? "0" + s : s}`;
}

function timeIsUp() {
  stopTimer();
  document.querySelector('.timer-box').classList.add('bg-danger', 'text-white');
  alarmSound.currentTime = 0;
  alarmSound.play().catch(e => console.log("Audio fail", e));
}

function stopAlarm() {
  alarmSound.pause();
  alarmSound.currentTime = 0;
  document.querySelector('.timer-box').classList.remove('bg-danger', 'text-white');
}
