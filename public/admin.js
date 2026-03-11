const API = "/api";

function getToken(){
  return localStorage.getItem('adminToken') || '';
}

function setLoginMsg(type, text){
  const el = document.getElementById('loginMsg');
  if(!el) return;
  if(!text){ el.innerHTML = ''; return; }
  const cls = type === 'ok' ? 'msg ok' : type === 'err' ? 'msg err' : 'msg';
  el.innerHTML = `<div class="${cls}">${text}</div>`;
}

async function login(){
  const password = document.getElementById('password').value;
  if(!password) return setLoginMsg('err', 'Ingresá la contraseña.');

  setLoginMsg('', 'Entrando...');

  try{
    const res = await fetch(`${API}/admin/login`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ password })
    });

    const data = await res.json();
    if(!res.ok) throw new Error(data?.error || 'Error');

    localStorage.setItem('adminToken', data.token);

    document.getElementById('login').style.display = 'none';
    document.getElementById('panel').style.display = 'block';

    await cargarUsuarios();

  }catch(e){
    setLoginMsg('err', e.message);
  }
}

function salir(){
  localStorage.removeItem('adminToken');
  location.reload();
}

function adminFetch(url, opts = {}){
  const headers = Object.assign({}, opts.headers || {}, {
    'X-Admin-Token': getToken(),
  });
  return fetch(url, { ...opts, headers });
}

// Auto login si ya hay token guardado
window.addEventListener('DOMContentLoaded', async () => {
  if(getToken()){
    document.getElementById('login').style.display = 'none';
    document.getElementById('panel').style.display = 'block';
    await cargarUsuarios();
  }
});

// CARGAR USUARIOS
async function cargarUsuarios(){
  const cont = document.getElementById('usuarios');
  cont.innerHTML = '<div class="msg">Cargando...</div>';

  try{
    const res = await adminFetch(`${API}/pagos`);
    const data = await res.json();

    if(!res.ok){
      throw new Error(data?.error || 'No autorizado');
    }

    const q = (document.getElementById('buscarTxt').value || '').trim().toLowerCase();
    const lista = q ? data.filter(u => (u.nombre || '').toLowerCase().includes(q)) : data;

    cont.innerHTML = '';

    if(lista.length === 0){
      cont.innerHTML = '<div class="msg">No hay usuarios para mostrar.</div>';
      return;
    }

    lista.forEach(u => {
      const div = document.createElement('div');
      div.className = 'user';

      const cuotas = Array.isArray(u.cuotas) ? u.cuotas : [];

      div.innerHTML = `
        <div class="row" style="justify-content:space-between; align-items:center;">
          <div>
            <h4>${escapeHtml(u.nombre)}</h4>
            <div class="small">Mail: ${escapeHtml(u.mail || '-')}&nbsp;&nbsp;|&nbsp;&nbsp;Tel: ${escapeHtml(u.telefono || '-')}</div>
          </div>
          <div class="row">
            <button class="btn2" onclick="eliminarUsuario('${u.id}')">Eliminar</button>
          </div>
        </div>

        <div style="margin-top:10px;">
          <b>Cuotas</b>
          <div id="cuotas-${u.id}" style="margin-top:6px;"></div>
        </div>

        <div class="row" style="margin-top:10px; align-items:center;">
          <input placeholder="Mes (Ej: Marzo 2026 o 2026-03)" id="mes-${u.id}" style="min-width:260px;" />
          <input type="number" placeholder="Monto" id="monto-${u.id}" style="width:140px;" />
          <button class="btn" onclick="agregarCuota('${u.id}')">Agregar cuota</button>
        </div>
      `;

      cont.appendChild(div);
      renderCuotas(u, cuotas);
    });

  }catch(e){
    cont.innerHTML = `<div class="msg err">${escapeHtml(e.message || 'Error')}</div>`;
    if((e.message || '').toLowerCase().includes('unauthorized') || (e.message || '').toLowerCase().includes('autoriz')){
      localStorage.removeItem('adminToken');
    }
  }
}

function renderCuotas(user, cuotas){
  const cont = document.getElementById(`cuotas-${user.id}`);
  cont.innerHTML = '';

  if(cuotas.length === 0){
    cont.innerHTML = '<div class="small">Sin cuotas cargadas.</div>';
    return;
  }

  cuotas.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'cuota';

    const estado = (c.estado || 'pendiente');

    row.innerHTML = `
      <div>
        <b>${escapeHtml(c.mes || '-')}</b>
        <div class="small">Monto: $${escapeHtml(String(c.monto ?? 0))}${c.totalPagado ? ` · Pagó: $${escapeHtml(String(c.totalPagado))}` : ''}</div>
      </div>
      <div class="row" style="align-items:center;">
        <select onchange="cambiarEstado('${user.id}', ${i}, this.value)">
          <option value="pendiente" ${estado === 'pendiente' ? 'selected' : ''}>pendiente</option>
          <option value="pagado" ${estado === 'pagado' ? 'selected' : ''}>pagado</option>
        </select>
        <button class="btn2" onclick="borrarCuota('${user.id}', ${i})">Borrar cuota</button>
      </div>
    `;

    cont.appendChild(row);
  });
}

async function agregarUsuario(){
  const nombre = document.getElementById('nuevoNombre').value.trim();
  const mail = document.getElementById('nuevoMail').value.trim();
  const telefono = document.getElementById('nuevoTelefono').value.trim();

  if(!nombre) return alert('Falta nombre');

  const res = await adminFetch(`${API}/pagos`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ nombre, mail, telefono, cuotas: [] })
  });

  const data = await res.json();
  if(!res.ok) return alert(data?.error || 'Error');

  document.getElementById('nuevoNombre').value = '';
  document.getElementById('nuevoMail').value = '';
  document.getElementById('nuevoTelefono').value = '';

  await cargarUsuarios();
}

async function obtenerUsuarioPorId(id){
  const res = await adminFetch(`${API}/pago/${id}`);
  const data = await res.json();
  if(!res.ok) throw new Error(data?.error || 'Error');
  return data;
}

async function agregarCuota(id){
  try{
    const mes = document.getElementById(`mes-${id}`).value.trim();
    const monto = Number(document.getElementById(`monto-${id}`).value);

    if(!mes) return alert('Falta mes');
    if(!Number.isFinite(monto) || monto < 0) return alert('Monto inválido');

    const user = await obtenerUsuarioPorId(id);
    user.cuotas = Array.isArray(user.cuotas) ? user.cuotas : [];
    user.cuotas.push({ mes, monto, estado:'pendiente' });

    const res = await adminFetch(`${API}/pago/${id}`, {
      method:'PUT',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(user)
    });

    const out = await res.json();
    if(!res.ok) throw new Error(out?.error || 'Error');

    await cargarUsuarios();
  }catch(e){
    alert(e.message);
  }
}

async function cambiarEstado(id, index, estado){
  try{
    const user = await obtenerUsuarioPorId(id);
    if(!Array.isArray(user.cuotas) || !user.cuotas[index]) return;

    user.cuotas[index].estado = estado;

    const res = await adminFetch(`${API}/pago/${id}`, {
      method:'PUT',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(user)
    });

    const out = await res.json();
    if(!res.ok) throw new Error(out?.error || 'Error');

    await cargarUsuarios();
  }catch(e){
    alert(e.message);
  }
}

async function borrarCuota(id, index){
  if(!confirm('¿Borrar esta cuota?')) return;
  try{
    const user = await obtenerUsuarioPorId(id);
    if(!Array.isArray(user.cuotas)) return;

    user.cuotas.splice(index, 1);

    const res = await adminFetch(`${API}/pago/${id}`, {
      method:'PUT',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(user)
    });

    const out = await res.json();
    if(!res.ok) throw new Error(out?.error || 'Error');

    await cargarUsuarios();
  }catch(e){
    alert(e.message);
  }
}

async function eliminarUsuario(id){
  if(!confirm('¿Eliminar usuario?')) return;

  const res = await adminFetch(`${API}/pago/${id}`, { method:'DELETE' });
  const data = await res.json();
  if(!res.ok) return alert(data?.error || 'Error');

  await cargarUsuarios();
}

async function subirExcel(){
  const file = document.getElementById('excel').files[0];
  if(!file) return alert('Seleccioná un Excel');

  const formData = new FormData();
  formData.append('excel', file);

  const res = await adminFetch(`${API}/importar-excel`, {
    method:'POST',
    body: formData
  });

  const data = await res.json();
  if(!res.ok) return alert(data?.error || 'Error');

  alert(`Excel importado. Filas: ${data.cantidad}`);
  await cargarUsuarios();
}

function escapeHtml(s){
  return String(s ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#39;');

}
