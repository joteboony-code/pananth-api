import os
from datetime import datetime, date

from dotenv import load_dotenv
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify

from models import db, Room, Tenant, Payment
from line_notify import send_line_notify, build_rent_message

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "dev-secret-key-change-in-production")
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL", "sqlite:///rental.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)

with app.app_context():
    db.create_all()


# ─── Dashboard ────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    total_rooms = Room.query.count()
    occupied = Room.query.filter_by(status="occupied").count()
    vacant = total_rooms - occupied
    pending_payments = Payment.query.filter_by(status="pending").count()
    recent_payments = (
        Payment.query.order_by(Payment.created_at.desc()).limit(5).all()
    )
    return render_template(
        "index.html",
        total_rooms=total_rooms,
        occupied=occupied,
        vacant=vacant,
        pending_payments=pending_payments,
        recent_payments=recent_payments,
    )


# ─── Rooms ────────────────────────────────────────────────────────────────────

@app.route("/rooms")
def rooms():
    all_rooms = Room.query.order_by(Room.number).all()
    return render_template("rooms.html", rooms=all_rooms)


@app.route("/rooms/add", methods=["GET", "POST"])
def add_room():
    if request.method == "POST":
        room = Room(
            number=request.form["number"].strip(),
            floor=request.form.get("floor") or None,
            monthly_rent=float(request.form["monthly_rent"]),
            status=request.form.get("status", "vacant"),
            description=request.form.get("description", "").strip(),
        )
        db.session.add(room)
        db.session.commit()
        flash(f"เพิ่มห้อง {room.number} เรียบร้อยแล้ว", "success")
        return redirect(url_for("rooms"))
    return render_template("room_form.html", room=None)


@app.route("/rooms/<int:room_id>/edit", methods=["GET", "POST"])
def edit_room(room_id):
    room = Room.query.get_or_404(room_id)
    if request.method == "POST":
        room.number = request.form["number"].strip()
        room.floor = request.form.get("floor") or None
        room.monthly_rent = float(request.form["monthly_rent"])
        room.status = request.form.get("status", "vacant")
        room.description = request.form.get("description", "").strip()
        db.session.commit()
        flash(f"แก้ไขห้อง {room.number} เรียบร้อยแล้ว", "success")
        return redirect(url_for("rooms"))
    return render_template("room_form.html", room=room)


@app.route("/rooms/<int:room_id>/delete", methods=["POST"])
def delete_room(room_id):
    room = Room.query.get_or_404(room_id)
    db.session.delete(room)
    db.session.commit()
    flash(f"ลบห้อง {room.number} เรียบร้อยแล้ว", "success")
    return redirect(url_for("rooms"))


# ─── Tenants ──────────────────────────────────────────────────────────────────

@app.route("/tenants")
def tenants():
    all_tenants = Tenant.query.order_by(Tenant.name).all()
    return render_template("tenants.html", tenants=all_tenants)


@app.route("/tenants/add", methods=["GET", "POST"])
def add_tenant():
    rooms = Room.query.filter_by(status="vacant").order_by(Room.number).all()
    if request.method == "POST":
        room_id = request.form.get("room_id") or None
        move_in_str = request.form.get("move_in_date")
        move_in = date.fromisoformat(move_in_str) if move_in_str else None

        tenant = Tenant(
            name=request.form["name"].strip(),
            phone=request.form.get("phone", "").strip(),
            line_token=request.form.get("line_token", "").strip(),
            move_in_date=move_in,
            room_id=room_id,
        )
        db.session.add(tenant)

        if room_id:
            room = Room.query.get(room_id)
            if room:
                room.status = "occupied"

        db.session.commit()
        flash(f"เพิ่มผู้เช่า {tenant.name} เรียบร้อยแล้ว", "success")
        return redirect(url_for("tenants"))
    return render_template("tenant_form.html", tenant=None, rooms=rooms)


@app.route("/tenants/<int:tenant_id>/edit", methods=["GET", "POST"])
def edit_tenant(tenant_id):
    tenant = Tenant.query.get_or_404(tenant_id)
    rooms = Room.query.order_by(Room.number).all()
    if request.method == "POST":
        old_room_id = tenant.room_id
        new_room_id = request.form.get("room_id") or None

        tenant.name = request.form["name"].strip()
        tenant.phone = request.form.get("phone", "").strip()
        tenant.line_token = request.form.get("line_token", "").strip()
        move_in_str = request.form.get("move_in_date")
        tenant.move_in_date = date.fromisoformat(move_in_str) if move_in_str else None
        tenant.room_id = new_room_id

        if old_room_id != new_room_id:
            if old_room_id:
                old_room = Room.query.get(old_room_id)
                if old_room:
                    old_room.status = "vacant"
            if new_room_id:
                new_room = Room.query.get(new_room_id)
                if new_room:
                    new_room.status = "occupied"

        db.session.commit()
        flash(f"แก้ไขข้อมูล {tenant.name} เรียบร้อยแล้ว", "success")
        return redirect(url_for("tenants"))
    return render_template("tenant_form.html", tenant=tenant, rooms=rooms)


@app.route("/tenants/<int:tenant_id>/delete", methods=["POST"])
def delete_tenant(tenant_id):
    tenant = Tenant.query.get_or_404(tenant_id)
    if tenant.room_id:
        room = Room.query.get(tenant.room_id)
        if room:
            room.status = "vacant"
    db.session.delete(tenant)
    db.session.commit()
    flash("ลบผู้เช่าเรียบร้อยแล้ว", "success")
    return redirect(url_for("tenants"))


# ─── Payments ─────────────────────────────────────────────────────────────────

@app.route("/payments")
def payments():
    now = datetime.now()
    year = int(request.args.get("year", now.year))
    month = int(request.args.get("month", now.month))

    all_payments = (
        Payment.query
        .filter_by(year=year, month=month)
        .join(Tenant)
        .order_by(Tenant.name)
        .all()
    )
    years = list(range(now.year - 2, now.year + 2))
    months_th = [
        (1, "มกราคม"), (2, "กุมภาพันธ์"), (3, "มีนาคม"), (4, "เมษายน"),
        (5, "พฤษภาคม"), (6, "มิถุนายน"), (7, "กรกฎาคม"), (8, "สิงหาคม"),
        (9, "กันยายน"), (10, "ตุลาคม"), (11, "พฤศจิกายน"), (12, "ธันวาคม"),
    ]
    return render_template(
        "payments.html",
        payments=all_payments,
        year=year,
        month=month,
        years=years,
        months_th=months_th,
    )


@app.route("/payments/generate", methods=["POST"])
def generate_payments():
    """Create payment records for all active tenants for a given month."""
    year = int(request.form["year"])
    month = int(request.form["month"])

    active_tenants = Tenant.query.filter_by(is_active=True).all()
    created = 0
    for tenant in active_tenants:
        if not tenant.room_id:
            continue
        exists = Payment.query.filter_by(
            tenant_id=tenant.id, year=year, month=month
        ).first()
        if not exists:
            payment = Payment(
                tenant_id=tenant.id,
                room_id=tenant.room_id,
                year=year,
                month=month,
                amount=tenant.room.monthly_rent,
            )
            db.session.add(payment)
            created += 1

    db.session.commit()
    flash(f"สร้างรายการค่าเช่าจำนวน {created} รายการเรียบร้อยแล้ว", "success")
    return redirect(url_for("payments", year=year, month=month))


@app.route("/payments/<int:payment_id>/edit", methods=["GET", "POST"])
def edit_payment(payment_id):
    payment = Payment.query.get_or_404(payment_id)
    if request.method == "POST":
        payment.amount = float(request.form["amount"])
        payment.water_unit = float(request.form.get("water_unit", 0))
        payment.water_rate = float(request.form.get("water_rate", 18))
        payment.electric_unit = float(request.form.get("electric_unit", 0))
        payment.electric_rate = float(request.form.get("electric_rate", 8))
        payment.note = request.form.get("note", "").strip()
        if request.form.get("status") == "paid" and payment.status != "paid":
            payment.status = "paid"
            payment.paid_at = datetime.utcnow()
        elif request.form.get("status") == "pending":
            payment.status = "pending"
            payment.paid_at = None
        db.session.commit()
        flash("อัปเดตรายการค่าเช่าเรียบร้อยแล้ว", "success")
        return redirect(url_for("payments", year=payment.year, month=payment.month))
    return render_template("payment_form.html", payment=payment)


@app.route("/payments/<int:payment_id>/mark-paid", methods=["POST"])
def mark_paid(payment_id):
    payment = Payment.query.get_or_404(payment_id)
    payment.status = "paid"
    payment.paid_at = datetime.utcnow()
    db.session.commit()
    flash(f"บันทึกการชำระเงินของ {payment.tenant.name} เรียบร้อยแล้ว", "success")
    return redirect(url_for("payments", year=payment.year, month=payment.month))


# ─── LINE Notify ──────────────────────────────────────────────────────────────

@app.route("/payments/<int:payment_id>/notify", methods=["POST"])
def notify_payment(payment_id):
    payment = Payment.query.get_or_404(payment_id)
    tenant = payment.tenant
    room = payment.room

    if not tenant.line_token:
        flash(f"ผู้เช่า {tenant.name} ยังไม่ได้ตั้งค่า LINE Token", "warning")
        return redirect(url_for("payments", year=payment.year, month=payment.month))

    message = build_rent_message(
        tenant_name=tenant.name,
        room_number=room.number,
        year=payment.year,
        month=payment.month,
        rent=payment.amount,
        water_cost=payment.water_cost,
        electric_cost=payment.electric_cost,
        total=payment.total_amount,
        month_name_th=payment.month_name_th,
    )

    result = send_line_notify(tenant.line_token, message)
    if result["success"]:
        payment.notified_at = datetime.utcnow()
        db.session.commit()
        flash(f"ส่งแจ้งเตือน LINE ให้ {tenant.name} เรียบร้อยแล้ว", "success")
    else:
        flash(f"ส่ง LINE ไม่สำเร็จ: {result['error']}", "danger")

    return redirect(url_for("payments", year=payment.year, month=payment.month))


@app.route("/payments/notify-all", methods=["POST"])
def notify_all():
    """Send LINE notification to all pending payments in a given month."""
    year = int(request.form["year"])
    month = int(request.form["month"])

    pending = Payment.query.filter_by(year=year, month=month, status="pending").all()
    sent, failed, skipped = 0, 0, 0

    for payment in pending:
        tenant = payment.tenant
        if not tenant.line_token:
            skipped += 1
            continue
        message = build_rent_message(
            tenant_name=tenant.name,
            room_number=payment.room.number,
            year=payment.year,
            month=payment.month,
            rent=payment.amount,
            water_cost=payment.water_cost,
            electric_cost=payment.electric_cost,
            total=payment.total_amount,
            month_name_th=payment.month_name_th,
        )
        result = send_line_notify(tenant.line_token, message)
        if result["success"]:
            payment.notified_at = datetime.utcnow()
            sent += 1
        else:
            failed += 1

    db.session.commit()
    flash(
        f"ส่งแจ้งเตือน LINE สำเร็จ {sent} ราย | ล้มเหลว {failed} ราย | ไม่มี token {skipped} ราย",
        "info",
    )
    return redirect(url_for("payments", year=year, month=month))


if __name__ == "__main__":
    app.run(debug=True, port=5000)
