// DIA Invoice Engine — pure calculation helpers. UI and IndexedDB stay outside this module.
export const roundMoney = value => Math.round(Number(value) || 0);
const nonNegative = value => Math.max(0, Number(value) || 0);

export function calculateInvoice(items = [], options = {}) {
  const normalizedItems = items.map(item => {
    const quantity = nonNegative(item.quantity);
    const unitPrice = roundMoney(item.unitPrice);
    const base = roundMoney(quantity * unitPrice);
    const lineDiscountType = item.discountType === 'percent' ? 'percent' : 'amount';
    const rawDiscount = nonNegative(item.discount);
    const calculatedDiscount = lineDiscountType === 'percent' ? base * Math.min(100, rawDiscount) / 100 : rawDiscount;
    const lineDiscount = Math.min(roundMoney(calculatedDiscount), base);
    const total = Math.max(0, base - lineDiscount);
    return { ...item, quantity, unitPrice, discountType: lineDiscountType, discount: lineDiscount, discountInput: rawDiscount, lineSubtotal: base, total };
  });

  const subtotal = normalizedItems.reduce((sum, item) => sum + item.total, 0);
  const itemDiscountTotal = normalizedItems.reduce((sum, item) => sum + item.discount, 0);
  const discountType = options.discountType === 'percent' ? 'percent' : 'amount';
  const rawInvoiceDiscount = nonNegative(options.discount);
  const invoiceDiscount = discountType === 'percent'
    ? Math.min(100, rawInvoiceDiscount) * subtotal / 100
    : rawInvoiceDiscount;
  const safeInvoiceDiscount = Math.min(subtotal, roundMoney(invoiceDiscount));
  const taxableAmount = Math.max(0, subtotal - safeInvoiceDiscount);
  const taxPercent = Math.min(100, nonNegative(options.taxPercent));
  const tax = options.taxEnabled ? roundMoney(taxableAmount * taxPercent / 100) : 0;
  const extraCosts = roundMoney(nonNegative(options.extraCosts));
  const total = Math.max(0, taxableAmount + tax + extraCosts);
  const paidAmount = Math.min(total, roundMoney(nonNegative(options.paidAmount)));
  const remainingAmount = Math.max(0, total - paidAmount);

  return {
    items: normalizedItems,
    subtotal,
    itemDiscountTotal,
    discountType,
    discountInput: rawInvoiceDiscount,
    discountTotal: safeInvoiceDiscount,
    // Keep legacy field name compatible with current database.
    discount: safeInvoiceDiscount,
    taxableAmount,
    taxPercent,
    tax,
    extraCosts,
    total,
    grandTotal: total,
    paidAmount,
    remainingAmount
  };
}

export function invoiceStatusFromPayment(status, paidAmount, total) {
  if (status === 'cancelled') return 'cancelled';
  const paid = roundMoney(paidAmount);
  const t = roundMoney(total);
  if (paid >= t && t > 0) return 'paid';
  if (paid > 0) return 'partially_paid';
  return status === 'draft' ? 'draft' : 'issued';
}
