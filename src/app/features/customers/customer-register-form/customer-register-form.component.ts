import { Component, inject, OnInit, OnChanges, SimpleChanges, signal, computed, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterModule } from '@angular/router';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { Customer, Branch, CenterOrSamity } from '../../../core/models/database.models';

@Component({
  selector: 'app-customer-register-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './customer-register-form.component.html',
  styleUrl: './customer-register-form.component.scss'
})
export class CustomerRegisterFormComponent implements OnInit, OnChanges {
  private kistiService = inject(KistiDatabaseService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  @Input() isModal: boolean = false;
  @Input() isBlankForm: boolean = false;
  @Input() initialBranches?: Branch[];
  @Input() initialCenters?: CenterOrSamity[];
  private defaultBranchIdVal?: number;

  @Input() set defaultBranchId(bId: number | undefined) {
    this.defaultBranchIdVal = bId;
    if (bId && this.form) {
      this.onBranchChange(bId);
    }
  }

  @Output() closeForm = new EventEmitter<void>();
  @Output() customerSaved = new EventEmitter<Customer>();

  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly submitting = signal<boolean>(false);
  readonly calculatedAge = signal<number | null>(null);
  readonly loading = signal<boolean>(false);
  readonly printBlankMode = signal<boolean>(false);

  form: any = this.getInitialFormData();

  get isBlank(): boolean {
    return this.isBlankForm || this.printBlankMode();
  }

  get availableCenters(): CenterOrSamity[] {
    const bId = Number(this.form?.branchId || 1);
    return this.centers().filter(c => c.branchId === bId);
  }

  get availableStaff() {
    return this.authService.availableUsers();
  }

  get selectedBranchName(): string {
    const bId = Number(this.form?.branchId);
    const b = this.branches().find(branch => branch.branchId === bId);
    return b ? `${b.name} (${b.branchCode})` : 'মিরপুর শাখা (Mirpur Branch) (BR-01)';
  }

  get selectedCenterName(): string {
    const cId = Number(this.form?.centerId);
    const c = this.centers().find(center => center.centerId === cId);
    return c ? `${c.name} (${c.centerCode})` : '';
  }

  get selectedOfficerName(): string {
    const sId = Number(this.form?.assignedFieldOfficerId);
    const s = this.availableStaff.find(staff => staff.userId === sId);
    return s ? s.name : '';
  }

  get formattedApplicationDate(): string {
    if (this.isBlank || !this.form?.applicationDate) {
      return '___ / ___ / ২০২_ ইং';
    }
    try {
      const parts = this.form.applicationDate.split('-');
      if (parts.length === 3) {
        return `${parts[2]} / ${parts[1]} / ${parts[0]} ইং`;
      }
      return '___ / ___ / ২০২_ ইং';
    } catch {
      return '___ / ___ / ২০২_ ইং';
    }
  }

  get formattedDob(): string {
    if (this.isBlank || !this.form?.dateOfBirth) {
      return '___/___/____';
    }
    try {
      const parts = this.form.dateOfBirth.split('-');
      if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
      }
      return '___/___/____';
    } catch {
      return '___/___/____';
    }
  }

  getDottedLine(value: string | undefined | null, targetLength: number = 40): string {
    if (this.isBlank) {
      return '.'.repeat(targetLength);
    }
    const valLen = (value || '').length;
    const remaining = Math.max(0, targetLength - Math.floor(valLen * 1.4));
    return '.'.repeat(remaining);
  }

  getBoxArray(value: string | undefined | null, length: number): string[] {
    const val = (this.isBlank ? '' : (value || '')).toUpperCase();
    const arr: string[] = [];
    for (let i = 0; i < length; i++) {
      arr.push(val[i] || '');
    }
    return arr;
  }

  getPhoneBoxArray(value: string | undefined | null): string[] {
    if (this.isBlank) {
      return Array(9).fill('');
    }
    let digits = (value || '').replace(/\D/g, '');
    if (digits.startsWith('01')) {
      digits = digits.substring(2);
    }
    const arr: string[] = [];
    for (let i = 0; i < 9; i++) {
      arr.push(digits[i] || '');
    }
    return arr;
  }

  get printDate(): string {
    return new Date().toLocaleDateString('bn-BD', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['initialBranches'] && this.initialBranches && this.initialBranches.length > 0) {
      this.branches.set(this.initialBranches);
      this.loading.set(false);
      const bId = this.defaultBranchIdVal || this.form?.branchId || this.initialBranches[0].branchId;
      this.onBranchChange(bId);
    }
    if (changes['initialCenters'] && this.initialCenters && this.initialCenters.length > 0) {
      this.centers.set(this.initialCenters);
    }
  }

  async ngOnInit() {
    this.onDobChange(this.form?.dateOfBirth);

    if (this.initialBranches && this.initialBranches.length > 0) {
      this.branches.set(this.initialBranches);
      this.loading.set(false);
      if (this.initialCenters) {
        this.centers.set(this.initialCenters);
      }
      return;
    }

    if (this.branches().length === 0) {
      if (!this.isBlank) {
        this.loading.set(true);
      }
      try {
        const [branches, centers] = await Promise.all([
          this.kistiService.getBranches(),
          this.kistiService.getCenters()
        ]);
        this.branches.set(branches);
        this.centers.set(centers);

        if (branches.length > 0) {
          const initialBranchId = this.defaultBranchIdVal || this.form.branchId || branches[0].branchId;
          this.onBranchChange(initialBranchId);
        }
      } catch (e) {
        console.error('Failed to load initial branches/centers:', e);
      } finally {
        this.loading.set(false);
      }
    }
  }

  getInitialFormData(): any {
    return {
      branchId: 1,
      centerId: 101,
      assignedFieldOfficerId: 502,
      formNo: `AF-${Math.floor(100000 + Math.random() * 900000)}`,
      applicationDate: new Date().toISOString().split('T')[0],
      fullName: '',
      fullNameEnglish: '',
      gender: 'FEMALE' as 'MALE' | 'FEMALE' | 'OTHER',
      fatherName: '',
      motherName: '',
      spouseName: '',
      dateOfBirth: '1995-01-01',
      nidNumber: '',
      birthCertificateNo: '',
      phonePrimary: '',
      phoneSecondary: '',
      presentAddress: {
        villageOrStreet: '',
        postOffice: '',
        thanaOrUpazila: 'মিরপুর',
        district: 'ঢাকা',
        houseOwnership: 'RENTED' as 'OWN' | 'RENTED' | 'FAMILY',
        stayDurationYears: 5
      },
      permanentAddress: {
        villageOrStreet: '',
        postOffice: '',
        thanaOrUpazila: '',
        district: ''
      },
      occupation: 'মুদি দোকান / ক্ষুদ্র ব্যবসা',
      businessName: '',
      monthlyIncome: 25000,
      familyTotalMembers: 4,
      familyEarningMembers: 1,
      primaryGuarantor: {
        name: '',
        relation: 'স্বামী',
        phone: '',
        nidNumber: '',
        address: '',
        occupation: 'চালক'
      },
      secondaryGuarantor: {
        name: '',
        relation: 'প্রতিবেশী',
        phone: '',
        nidNumber: '',
        address: '',
        occupation: 'ব্যবসায়ী'
      },
      collateral: {
        hasBankCheque: true,
        bankName: 'ইসলামী ব্যাংক বাংলাদেশ পিএলসি',
        bankBranch: 'মিরপুর শাখা',
        accountNumber: '',
        chequeNumber: '',
        hasStamp: true,
        stampNumber: '',
        otherMortgageDetails: ''
      },
      admissionFee: 100,
      initialSavingsDeposit: 500
    };
  }

  onBranchChange(branchId: any) {
    const bId = Number(branchId);
    this.form.branchId = bId;
    const centers = this.centers().filter(c => c.branchId === bId);
    if (centers.length > 0) {
      this.form.centerId = centers[0].centerId;
      this.form.assignedFieldOfficerId = centers[0].fieldOfficerUserId || this.form.assignedFieldOfficerId;
    } else {
      this.form.centerId = null;
    }
  }

  onCenterChange(centerId: any) {
    const cId = Number(centerId);
    this.form.centerId = cId;
    const center = this.centers().find(c => c.centerId === cId);
    if (center && center.fieldOfficerUserId) {
      this.form.assignedFieldOfficerId = center.fieldOfficerUserId;
    }
  }

  onDobChange(dobString: string) {
    if (!dobString) {
      this.calculatedAge.set(null);
      return;
    }
    const birthDate = new Date(dobString);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    this.calculatedAge.set(age > 0 ? age : null);
  }

  printForm(isBlankOnly: boolean = false) {
    const origTitle = document.title;
    const formNo = isBlankOnly ? 'Blank' : (this.form?.formNo || 'New');
    const custName = (!isBlankOnly && this.form?.fullName) ? `-${this.form.fullName.trim().replace(/\s+/g, '_')}` : '';
    document.title = `eKisti-সদস্য-ভর্তি-আবেদন-ফরম-${formNo}${custName}`;

    if (isBlankOnly) {
      this.printBlankMode.set(true);
    }

    setTimeout(() => {
      window.print();
      setTimeout(() => {
        if (isBlankOnly) {
          this.printBlankMode.set(false);
        }
        document.title = origTitle;
      }, 500);
    }, 60);
  }

  onCancel() {
    if (this.isModal) {
      this.closeForm.emit();
    } else {
      this.router.navigate(['/customers']);
    }
  }

  async submitRegistration() {
    if (!this.form.fullName?.trim()) {
      alert('অনুগ্রহ করে আবেদনকারীর পূর্ণ নাম (বাংলায়) লিখুন');
      return;
    }
    if (!this.form.phonePrimary?.trim()) {
      alert('অনুগ্রহ করে গ্রাহকের প্রাথমিক মোবাইল নম্বর লিখুন');
      return;
    }
    if (!this.form.nidNumber?.trim()) {
      alert('অনুগ্রহ করে গ্রাহকের জাতীয় পরিচয়পত্র (NID) নম্বর লিখুন');
      return;
    }
    if (!this.form.branchId) {
      alert('অনুগ্রহ করে শাখা নির্বাচন করুন');
      return;
    }
    if (!this.form.centerId) {
      alert('অনুগ্রহ করে সমিতি / রুট নির্বাচন করুন');
      return;
    }
    if (!this.form.primaryGuarantor?.name?.trim()) {
      alert('অনুগ্রহ করে ১ম জামিনদারের নাম লিখুন');
      return;
    }

    this.submitting.set(true);
    const currentUser = this.authService.currentUser();

    try {
      const initialSavings = Number(this.form.initialSavingsDeposit) || 0;

      const customerPayload: any = {
        branchId: Number(this.form.branchId),
        centerId: Number(this.form.centerId),
        assignedFieldOfficerId: Number(this.form.assignedFieldOfficerId) || currentUser.userId,
        fullName: this.form.fullName.trim(),
        fatherName: this.form.fatherName?.trim() || '',
        motherName: this.form.motherName?.trim() || '',
        spouseName: this.form.spouseName?.trim() || '',
        dateOfBirth: this.form.dateOfBirth || '1995-01-01',
        gender: this.form.gender || 'FEMALE',
        phonePrimary: this.form.phonePrimary.trim(),
        phoneSecondary: this.form.phoneSecondary?.trim() || '',
        nidNumber: this.form.nidNumber.trim(),
        birthCertificateNo: this.form.birthCertificateNo?.trim() || '',
        presentAddress: {
          villageOrStreet: this.form.presentAddress?.villageOrStreet?.trim() || '',
          postOffice: this.form.presentAddress?.postOffice?.trim() || '',
          thanaOrUpazila: this.form.presentAddress?.thanaOrUpazila?.trim() || '',
          district: this.form.presentAddress?.district?.trim() || 'ঢাকা',
          houseOwnership: this.form.presentAddress?.houseOwnership || 'OWN'
        },
        permanentAddress: {
          villageOrStreet: this.form.permanentAddress?.villageOrStreet?.trim() || '',
          postOffice: this.form.permanentAddress?.postOffice?.trim() || '',
          thanaOrUpazila: this.form.permanentAddress?.thanaOrUpazila?.trim() || '',
          district: this.form.permanentAddress?.district?.trim() || ''
        },
        occupation: this.form.occupation?.trim() || 'ব্যবসা',
        businessName: this.form.businessName?.trim() || '',
        monthlyIncome: Number(this.form.monthlyIncome) || 0,
        primaryGuarantor: {
          name: this.form.primaryGuarantor.name.trim(),
          relation: this.form.primaryGuarantor.relation?.trim() || 'স্বামী',
          phone: this.form.primaryGuarantor.phone?.trim() || '',
          nidNumber: this.form.primaryGuarantor.nidNumber?.trim() || '',
          address: this.form.primaryGuarantor.address?.trim() || '',
          occupation: this.form.primaryGuarantor.occupation?.trim() || ''
        },
        secondaryGuarantor: {
          name: this.form.secondaryGuarantor?.name?.trim() || '',
          relation: this.form.secondaryGuarantor?.relation?.trim() || '',
          phone: this.form.secondaryGuarantor?.phone?.trim() || '',
          nidNumber: this.form.secondaryGuarantor?.nidNumber?.trim() || '',
          address: this.form.secondaryGuarantor?.address?.trim() || '',
          occupation: this.form.secondaryGuarantor?.occupation?.trim() || ''
        },
        collateral: {
          hasBankCheque: Boolean(this.form.collateral?.hasBankCheque),
          bankName: this.form.collateral?.bankName?.trim() || '',
          bankBranch: this.form.collateral?.bankBranch?.trim() || '',
          accountNumber: this.form.collateral?.accountNumber?.trim() || '',
          chequeNumber: this.form.collateral?.chequeNumber?.trim() || '',
          hasStamp: Boolean(this.form.collateral?.hasStamp),
          stampNumber: this.form.collateral?.stampNumber?.trim() || '',
          otherMortgageDetails: this.form.collateral?.otherMortgageDetails?.trim() || ''
        },
        totalSavingsBalance: initialSavings,
        totalLoansTaken: 0,
        activeLoansCount: 0,
        totalPrincipalBorrowed: 0,
        totalPrincipalPaid: 0,
        totalInterestPaid: 0,
        creditScore: 'GOOD',
        status: 'ACTIVE'
      };

      const newCustomer = await this.kistiService.createCustomer(
        customerPayload,
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        `সদস্য ভর্তি ফরমের মাধ্যমে নতুন গ্রাহক নিবন্ধন (ফরম #${this.form.formNo || ''})`
      );

      // Record initial savings transaction if deposit > 0
      if (initialSavings > 0) {
        try {
          await this.kistiService.recordSavingsTransaction(
            {
              customerId: newCustomer.customerId,
              customerName: newCustomer.fullName,
              branchId: newCustomer.branchId,
              centerId: newCustomer.centerId,
              type: 'DEPOSIT',
              amount: initialSavings,
              isCredit: true,
              paymentMethod: 'CASH',
              previousBalance: 0,
              newBalance: initialSavings,
              transactionDate: this.form.applicationDate ? new Date(this.form.applicationDate).toISOString() : new Date().toISOString(),
              reason: 'সদস্য ভর্তি ফরম থেকে প্রাথমিক সঞ্চয় জমা',
              performedByUserId: currentUser.userId,
              performedByName: currentUser.name,
              performedByRole: currentUser.role,
              receiptNo: `SAV-ADM-${newCustomer.customerId}`
            },
            { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
            'সদস্য ভর্তি ফরম থেকে প্রাথমিক সঞ্চয় জমা'
          );
        } catch (sErr) {
          console.warn('Could not record initial savings ledger:', sErr);
        }
      }

      alert(`সফল! নতুন সদস্য #${newCustomer.customerId} (${newCustomer.fullName}) সফলভাবে নিবন্ধিত হয়েছে।`);
      this.customerSaved.emit(newCustomer);

      if (!this.isModal) {
        this.router.navigate(['/customers']);
      }
    } catch (err) {
      console.error('Customer registration error:', err);
      alert('গ্রাহক নিবন্ধন করতে সমস্যা হয়েছে। অনুগ্রহ করে পুনরায় চেষ্টা করুন।');
    } finally {
      this.submitting.set(false);
    }
  }
}
