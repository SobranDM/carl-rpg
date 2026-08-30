import CarlRPGItemBase from "./item-base.mjs";

export default class CarlRPGItem extends CarlRPGItemBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = super.defineSchema();

    schema.quantity = new fields.NumberField({ ...requiredInteger, initial: 1, min: 0 });
    schema.weight = new fields.NumberField({ required: true, nullable: false, initial: 0, min: 0 });
    schema.equipped = new fields.BooleanField({ required: true, initial: false });

    return schema;
  }
}
