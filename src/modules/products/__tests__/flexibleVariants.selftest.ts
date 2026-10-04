import assert from "node:assert/strict";
import {
  compareVariants,
  generateCombinations,
  naturalSizeCompare,
  parseSizes,
  variantByCode,
  variantSizeValue,
  type ProductVariant,
} from "../variants";

const parsed=parseSizes("XS, S, M, L, 42, 3-4Y, 28x30, One Size");
assert.deepEqual(parsed,["XS","S","M","L","3-4Y","28x30","42","One Size"]);
assert.deepEqual(parseSizes("10 2 2 10.5"),["2","10","10.5"]);
assert.deepEqual(["10","2","One Size","M","XS"].sort(naturalSizeCompare),["XS","M","2","10","One Size"]);

const combinations=generateCombinations([
  {color_ar:"أحمر",color_en:null,color_hex:null},
  {color_ar:null,color_en:"Blue",color_hex:"#3b82f6"},
],["S","28x30","One Size"]);
assert.equal(combinations.length,6);
assert.deepEqual(combinations.slice(0,3).map((row)=>[row.size_value,row.size_sort_order]),[
  ["S",0],["28x30",1],["One Size",2],
]);
assert.equal(combinations[0].color_key,"أحمر","Arabic-only color names are stable identities");

const base:ProductVariant={
  id:"v",product_id:"p",sku:"VAR-S",barcode:"SCAN-S",color_key:"blue",color_ar:null,color_en:"Blue",
  color_hex:"#3b82f6",size:null,size_label:"S",size_value:"S",size_sort_order:2,image_url:null,
  price_override:null,cost_override:null,stock_quantity:1,low_stock_level:0,active:true,sort_order:0,
  created_at:"2026-01-01T00:00:00Z",updated_at:"2026-01-01T00:00:00Z",
};
assert.equal(variantSizeValue(base),"S");
assert.equal(variantByCode([base],"scan-s")?.id,"v");
assert.equal(variantByCode([base],"#3b82f6"),null,"a visual swatch is never a scannable identifier");
const blackSizes=["40","41","42","43"].map((size,index):ProductVariant=>({
  ...base,id:`black-${size}`,product_id:"alyq-01",sku:`ALYQ-01-BLK-${size}`,
  barcode:`629ALYQ01${size}`,color_key:"black",color_ar:"أسود",color_en:"Black",
  size:Number(size),size_label:null,size_value:size,size_sort_order:index,stock_quantity:size==="42"?10:0,
}));
const scanned42=variantByCode(blackSizes,"629alyq0142");
assert.equal(scanned42?.id,"black-42");
assert.equal(scanned42?.sku,"ALYQ-01-BLK-42");
assert.equal(scanned42?.stock_quantity,10,"scan resolves the exact branch-overlaid Black / 42 shelf");
assert.ok(compareVariants({...base,id:"manual-first",size_value:"XL",size_sort_order:0},{...base,id:"manual-second",size_value:"XS",size_sort_order:1})<0,
  "explicit merchant order wins over natural letter order");

console.log("11/11 flexible size, Arabic color, ordering and exact scan tests passed");
