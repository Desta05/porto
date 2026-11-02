/**
 * Helper Waktu Konsisten Asia/Jakarta (WIB)
 */

/**
 * Format tanggal ke string 'YYYY-MM-DD HH:mm:ss' dalam zona waktu Asia/Jakarta
 * @param {Date|number|string} dateInput
 * @returns {string}
 */
function formatJakartaTimestamp(dateInput) {
    const d = dateInput instanceof Date 
        ? dateInput 
        : (dateInput ? new Date(typeof dateInput === 'number' && dateInput < 1e11 ? dateInput * 1000 : dateInput) : new Date());

    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(d);

    const get = (type) => parts.find(p => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * Hitung rentang waktu rekap 24 jam (jam 23.00 WIB kemarin s/d jam 23.00 WIB hari ini)
 * serta batas 7 hari (pelanggar berulang) dan 30 hari (pembersihan data lama)
 * @param {Date} [refDate]
 */
function getJakartaRecapRange(refDate = new Date()) {
    const nowJakarta = formatJakartaTimestamp(refDate);
    const [datePart] = nowJakarta.split(' ');
    const [year, month, day] = datePart.split('-').map(Number);

    // 23:00:00 WIB sama dengan 16:00:00 UTC (WIB = UTC+7)
    const endUtc = Date.UTC(year, month - 1, day, 16, 0, 0);
    const startUtc = endUtc - (24 * 60 * 60 * 1000);            // 24 jam sebelumnya
    const sevenDaysUtc = endUtc - (7 * 24 * 60 * 60 * 1000);     // 7 hari sebelumnya
    const thirtyDaysUtc = endUtc - (30 * 24 * 60 * 60 * 1000);   // 30 hari sebelumnya

    return {
        startTime: formatJakartaTimestamp(new Date(startUtc)),
        endTime: formatJakartaTimestamp(new Date(endUtc)),
        sevenDaysAgo: formatJakartaTimestamp(new Date(sevenDaysUtc)),
        thirtyDaysAgo: formatJakartaTimestamp(new Date(thirtyDaysUtc))
    };
}

module.exports = {
    formatJakartaTimestamp,
    getJakartaRecapRange
};
