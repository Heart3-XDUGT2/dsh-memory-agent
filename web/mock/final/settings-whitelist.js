/* QQ list adapters. Parsing and admission remain owned by the QQ plugin. */
(function(root){
  'use strict';
  const split = text => String(text ?? '').split(/[\s,;，、]+/).filter(Boolean);
  const valid = (text,kind) => kind==='watch-string' ? /^\d{4,15}$/.test(text) : text.trim()!=='';
  function model(value,kind){
    const original=structuredClone(value),initial=kind==='watch-string'?split(value):Array.isArray(value)?value.map(String):[];
    let rows=[...initial];
    return {
      get rows(){return [...rows];},
      value(){return rows.length===initial.length&&rows.every((s,i)=>s===initial[i])?structuredClone(original):kind==='watch-string'?rows.join('\n'):[...rows];},
      replace(i,text){rows[i]=String(text);return this.value();},
      add(text=''){rows.push(String(text));return this.value();},
      remove(i){rows.splice(i,1);return this.value();},
      review(text){const seen=new Set(rows.map(s=>s.trim()));return split(text).map(text=>{const duplicate=seen.has(text),ok=valid(text,kind);seen.add(text);return{text,duplicate,valid:ok};});},
      append(items){rows.push(...items.map(i=>i.text));return this.value();},
      issues(){const seen=new Set();return rows.map(text=>{const duplicate=seen.has(text.trim());seen.add(text.trim());return{valid:valid(text,kind),duplicate};});}
    };
  }
  root.EchoWhitelist={model,split,valid};
})(globalThis);
