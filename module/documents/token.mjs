/**
 * Extend the base TokenDocument.
 * @extends {TokenDocument}
 */
export class CarlRPGTokenDocument extends foundry.documents.TokenDocument {
  /**
   * A bar on a resource with bonus slots (hb: hb.effectiveMax, from gear and
   * other "hb.max" bonuses) fills to its effective max, not the base max -
   * the same limit CarlRPGActor#modifyTokenAttribute clamps a bar edit to.
   * @override
   */
  getBarAttribute(barName, options = {}) {
    const data = super.getBarAttribute(barName, options);
    if (data?.type !== "bar") return data;
    const effectiveMax = foundry.utils.getProperty(
      this.actor?.system ?? {},
      `${data.attribute}.effectiveMax`,
    );
    if (Number.isFinite(effectiveMax)) data.max = effectiveMax;
    return data;
  }
}
